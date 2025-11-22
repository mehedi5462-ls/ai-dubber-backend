// server.js - Full backend for Render AI Dubber
// Accepts POST /dub with form-data 'video', runs ffmpeg, whisper.cpp, LibreTranslate, Coqui TTS, and merges result.
// Note: Requires binaries: /opt/whisper (whisper.cpp main), ffmpeg in PATH, and `tts` CLI (coqui-tts) available.
const express = require('express');
const multer = require('multer');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 10000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const MODELS_DIR = path.join(__dirname, 'models');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const id = Date.now() + '_' + uuidv4();
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, id + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB limit

// helper exec promise
function run(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, Object.assign({ maxBuffer: 1024 * 1024 * 200 }, opts), (err, stdout, stderr) => {
      if (err) {
        return reject({ err, stdout: stdout || '', stderr: stderr || '' });
      }
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

app.get('/', (req, res) => {
  res.send('Render AI Dubber up. POST /dub with form field \"video\"');
});

app.post('/dub', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No video file uploaded (field \"video\")' });

    const videoPath = req.file.path;
    const base = path.basename(videoPath);
    const id = path.parse(base).name;
    const wavPath = path.join(UPLOAD_DIR, id + '.wav');
    const transcriptTxt = path.join(UPLOAD_DIR, id + '.txt');
    const translatedTxt = path.join(UPLOAD_DIR, id + '.hi.txt');
    const ttsWav = path.join(UPLOAD_DIR, id + '.hi.wav');
    const outVideo = path.join(UPLOAD_DIR, id + '.dub.mp4');

    // 1) extract audio (mono 16k)
    await run(`ffmpeg -y -i ${escapeShell(videoPath)} -vn -acodec pcm_s16le -ar 16000 -ac 1 ${escapeShell(wavPath)}`);

    // 2) transcribe using whisper.cpp binary (assumes /opt/whisper binary)
    const whisperBinary = process.env.WHISPER_BIN || '/opt/whisper';
    const whisperModel = process.env.WHISPER_MODEL || path.join(__dirname, 'models', 'ggml-base.bin');
    // Build command - whisper.cpp supports -otxt -of to write output to file prefix
    const whisperOutPrefix = transcriptTxt; // whisper will create transcriptTxt + ".txt"
    let whisperCmd = `${escapeShell(whisperBinary)} -m ${escapeShell(whisperModel)} -f ${escapeShell(wavPath)} -otxt -of ${escapeShell(whisperOutPrefix)}`;
    try {
      await run(whisperCmd);
    } catch (err) {
      // fallback: try basic invocation (stdout)
      try {
        const basic = `${escapeShell(whisperBinary)} -m ${escapeShell(whisperModel)} -f ${escapeShell(wavPath)}`;
        const r = await run(basic);
        fs.writeFileSync(transcriptTxt + '.txt', r.stdout, 'utf8');
      } catch (e) {
        return res.status(500).json({ error: 'Whisper transcription failed. Check whisper binary and model.', detail: e.stderr ? e.stderr.slice(0,1000) : String(e) });
      }
    }

    // read transcript (whisper outputs to file transcriptTxt+".txt")
    let transcript = '';
    if (fs.existsSync(transcriptTxt + '.txt')) {
      transcript = fs.readFileSync(transcriptTxt + '.txt', 'utf8');
    } else if (fs.existsSync(transcriptTxt)) {
      transcript = fs.readFileSync(transcriptTxt, 'utf8');
    } else {
      const fallbackFiles = fs.readdirSync(UPLOAD_DIR).filter(f => f.startsWith(id) && f.endsWith('.txt'));
      if (fallbackFiles.length) transcript = fs.readFileSync(path.join(UPLOAD_DIR, fallbackFiles[0]), 'utf8');
    }

    if (!transcript || transcript.trim().length === 0) {
      return res.status(500).json({ error: 'Transcription empty. Check whisper output.' });
    }

    // 3) translate with LibreTranslate (id -> hi)
    const libURL = process.env.LIBRETRANSLATE_URL || 'https://libretranslate.com/translate';
    let tResp;
    try {
      tResp = await axios.post(libURL, {
        q: transcript,
        source: 'id',
        target: 'hi',
        format: 'text'
      }, { headers: { 'Content-Type': 'application/json' }, timeout: 120000 });
    } catch (err) {
      return res.status(500).json({ error: 'Translate failed', detail: err.message });
    }
    const translatedText = (tResp.data && tResp.data.translatedText) ? tResp.data.translatedText : '';
    if (!translatedText) return res.status(500).json({ error: 'Translation returned empty' });
    fs.writeFileSync(translatedTxt, translatedText, 'utf8');

    // 4) TTS using coqui-tts 'tts' CLI
    const ttsTextFile = path.join(UPLOAD_DIR, id + '.for_tts.txt');
    fs.writeFileSync(ttsTextFile, translatedText, 'utf8');
    const ttsCmdEnv = process.env.TTS_CMD || `tts --text_file ${escapeShell(ttsTextFile)} --out_path ${escapeShell(ttsWav)}`;
    try {
      await run(ttsCmdEnv, { maxBuffer: 1024 * 1024 * 200 });
    } catch (e) {
      return res.status(500).json({ error: 'TTS generation failed', detail: e.stderr ? e.stderr.slice(0,1000) : String(e) });
    }

    if (!fs.existsSync(ttsWav)) {
      return res.status(500).json({ error: 'TTS output not found at ' + ttsWav });
    }

    // 5) Merge TTS audio into video (replace audio stream)
    await run(`ffmpeg -y -i ${escapeShell(videoPath)} -i ${escapeShell(ttsWav)} -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k ${escapeShell(outVideo)}`);

    // Return download endpoint
    const downloadUrl = `/download/${path.basename(outVideo)}`;
    return res.json({ output: downloadUrl, filename: path.basename(outVideo) });

  } catch (err) {
    console.error('ERR', err);
    return res.status(500).json({ error: 'Server error', detail: err.stderr ? err.stderr.slice(0,1000) : String(err) });
  }
});

// Endpoint to stream downloads (simple)
app.get('/download/:file', (req, res) => {
  const fname = req.params.file;
  const fpath = path.join(UPLOAD_DIR, fname);
  if (!fs.existsSync(fpath)) return res.status(404).send('File not found');
  res.download(fpath);
});

app.listen(PORT, () => {
  console.log(`AI dubber listening on ${PORT}`);
});

// helper to escape shell paths
function escapeShell(cmdPath) {
  if (!cmdPath) return "''";
  return `'${cmdPath.replace(/'/g, `'\\''`)}'`;
}
