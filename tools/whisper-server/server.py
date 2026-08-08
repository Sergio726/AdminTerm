"""
Servidor de transcripcion local para AdminTerm.

Envuelve faster-whisper en una API compatible con la de OpenAI, de modo que el
microfono de AdminTerm funcione sin conexion, sin API key y sin coste, apuntando
al preset "Servidor local".

    python server.py --model small --port 8756

Escucha solo en la interfaz de loopback: no queda expuesto a la red.
"""

import argparse
import io
import sys
import time
from typing import Optional

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse

# Marca que permite a AdminTerm distinguir este servidor de cualquier otra cosa
# que pudiera estar ocupando el puerto.
SERVICE = "adminterm-whisper"

# Tamanos que faster-whisper sabe resolver por nombre. Si la peticion pide uno
# de estos, se respeta; cualquier otro valor (por ejemplo "whisper-1", que es lo
# que manda un cliente pensado para OpenAI) cae al modelo por defecto.
KNOWN_SIZES = {
    "tiny", "tiny.en", "base", "base.en", "small", "small.en",
    "medium", "medium.en", "large-v1", "large-v2", "large-v3",
    "large-v3-turbo", "turbo", "distil-small.en", "distil-large-v3",
}

app = FastAPI(title="AdminTerm Whisper", docs_url=None, redoc_url=None)

CONFIG = {
    "model": "small",
    "device": "cpu",
    "compute_type": "int8",
    "cpu_threads": 4,
    "local_files_only": False,
}
MODELS = {}


def log(message: str) -> None:
    # flush explicito: AdminTerm lee esta salida para saber en que va el arranque.
    print(f"[whisper] {message}", flush=True)


def get_model(size: str):
    """Devuelve el modelo pedido, cargandolo la primera vez."""
    from faster_whisper import WhisperModel

    if size not in MODELS:
        started = time.perf_counter()
        log(f"cargando modelo {size} ({CONFIG['device']}/{CONFIG['compute_type']})...")
        MODELS[size] = WhisperModel(
            size,
            device=CONFIG["device"],
            compute_type=CONFIG["compute_type"],
            cpu_threads=CONFIG["cpu_threads"],
            local_files_only=CONFIG["local_files_only"],
        )
        log(f"modelo {size} listo en {time.perf_counter() - started:.1f}s")
    return MODELS[size]


def error(status: int, message: str):
    """Forma de error que AdminTerm ya sabe leer: error.message."""
    return JSONResponse(status_code=status, content={"error": {"message": message}})


@app.exception_handler(Exception)
async def unhandled(_request: Request, exc: Exception):
    log(f"error no controlado: {exc!r}")
    return error(500, f"{type(exc).__name__}: {exc}")


@app.get("/health")
async def health():
    return {
        "service": SERVICE,
        "ready": bool(MODELS),
        "model": CONFIG["model"],
        "loaded": sorted(MODELS),
        "device": CONFIG["device"],
        "compute_type": CONFIG["compute_type"],
    }


@app.get("/v1/models")
async def models():
    return {
        "object": "list",
        "data": [{"id": s, "object": "model", "owned_by": SERVICE} for s in sorted(KNOWN_SIZES)],
    }


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: UploadFile = File(...),
    model: Optional[str] = Form(None),
    language: Optional[str] = Form(None),
    response_format: Optional[str] = Form("json"),
    prompt: Optional[str] = Form(None),
    temperature: Optional[float] = Form(0.0),
):
    data = await file.read()
    if not data:
        return error(400, "El audio recibido esta vacio.")

    size = model if model in KNOWN_SIZES else CONFIG["model"]
    started = time.perf_counter()

    try:
        whisper = get_model(size)
    except Exception as exc:  # modelo inexistente, descarga fallida, disco...
        return error(500, f"No se pudo cargar el modelo '{size}': {exc}")

    try:
        # PyAV decodifica el contenedor: el webm/opus del microfono y el WAV de
        # la prueba de conexion entran los dos por aqui, sin ffmpeg externo.
        segments, info = whisper.transcribe(
            io.BytesIO(data),
            language=(language or None),
            initial_prompt=(prompt or None),
            temperature=(temperature if temperature is not None else 0.0),
            beam_size=5,
            # Whisper inventa texto sobre el silencio. En dictado corto eso se
            # nota mucho, asi que se recorta el silencio y no se arrastra
            # contexto entre segmentos.
            vad_filter=True,
            condition_on_previous_text=False,
        )
        collected = list(segments)
    except Exception as exc:
        return error(400, f"No se pudo transcribir el audio: {exc}")

    text = "".join(s.text for s in collected).strip()
    elapsed = time.perf_counter() - started
    log(
        f"{len(data)} bytes -> {len(text)} caracteres en {elapsed:.2f}s "
        f"(modelo={size}, idioma={info.language}, audio={info.duration:.1f}s)"
    )

    if response_format == "text":
        return PlainTextResponse(text)

    if response_format in ("verbose_json", "srt", "vtt"):
        return {
            "task": "transcribe",
            "language": info.language,
            "duration": info.duration,
            "text": text,
            "segments": [
                {"id": i, "start": s.start, "end": s.end, "text": s.text}
                for i, s in enumerate(collected)
            ],
        }

    return {"text": text}


def main() -> int:
    parser = argparse.ArgumentParser(description="Servidor Whisper local para AdminTerm")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8756)
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda", "auto"])
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--cpu-threads", type=int, default=4)
    parser.add_argument(
        "--offline",
        action="store_true",
        help="No consultar Hugging Face: exige que el modelo ya este en cache.",
    )
    args = parser.parse_args()

    CONFIG.update(
        model=args.model,
        device=args.device,
        compute_type=args.compute_type,
        cpu_threads=args.cpu_threads,
        local_files_only=args.offline,
    )

    try:
        import uvicorn
    except ImportError:
        log("falta uvicorn. Instala:  pip install fastapi uvicorn python-multipart")
        return 2

    # El modelo se carga ANTES de abrir el puerto: asi, para quien sondea, que el
    # servidor responda significa que ya puede transcribir.
    try:
        get_model(args.model)
    except Exception as exc:
        log(f"no se pudo cargar el modelo '{args.model}': {exc}")
        return 1

    log(f"escuchando en http://{args.host}:{args.port}  (Ctrl+C para parar)")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning", access_log=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
