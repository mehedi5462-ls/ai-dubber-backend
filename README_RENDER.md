# Render AI Dubbing Backend (GitHub-ready)

## Deploy Steps
1. Create a GitHub repo and upload these files.
2. Go to Render.com → New → Web Service.
3. Choose Docker environment.
4. Add ENV:
   MODEL_URL = direct link to whisper model (ggml-base.bin)
   WHISPER_MODEL (optional) = path in container, default models/ggml-base.bin
   TTS_CMD (optional) = override tts command
5. Deploy.

POST /dub with form-data `video` to process.
