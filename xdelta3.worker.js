import createXdelta3Module from './xdelta3.js';

const bufferSize = 4 * 1024 * 1024; // 4MB buffer
const cacheSize = 32;               // 32 slots LRU cache

let mod = undefined;
const state = {
  sourceFile: undefined,
  patchFile: undefined,
  errorMessage: undefined,
};

const reader = new FileReaderSync();

function readSource(buffer, offset, size) {
  return readFile(state.sourceFile, buffer, Number(offset), size);
}

let lastReportTime = 0;
function readPatch(buffer, offset, size) {
  const now = Date.now();
  if (now - lastReportTime > 100) {
    lastReportTime = now;
    const offNum = Number(offset);
    const pct = state.patchFile.size > 0 ? Math.min(99, Math.round((offNum / state.patchFile.size) * 100)) : 0;
    postMessage({ type: 'progress', pct, current: offNum, total: state.patchFile.size });
  }
  return readFile(state.patchFile, buffer, Number(offset), size);
}

function readFile(file, buffer, offset, size) {
  const end = Math.min(file.size, offset + size);
  if (offset >= file.size) return 0;
  const blob = file.slice(offset, end);
  const read = end - offset;
  const data = reader.readAsArrayBuffer(blob);
  mod.HEAP8.set(new Uint8Array(data), buffer);
  return read;
}

function outputFile(buffer, size) {
  // Copy bytes out of WebAssembly heap into transferable Uint8Array
  const chunk = new Uint8Array(mod.HEAP8.buffer, buffer, size);
  const copy = new Uint8Array(chunk);
  postMessage({ type: 'chunk', bytes: copy }, [copy.buffer]);
}

function reportError(buffer) {
  state.errorMessage = mod.UTF8ToString(buffer);
}

onmessage = async function (event) {
  if (!event.data) return;
  const { command, sourceFile, patchFile, disableChecksum, wasmBinary } = event.data;
  if (command !== 'start') return;

  state.sourceFile = sourceFile;
  state.patchFile = patchFile;
  state.errorMessage = undefined;

  try {
    const opts = {};
    if (wasmBinary) {
      opts.wasmBinary = wasmBinary;
    }
    opts.locateFile = (path) => path;

    mod = await createXdelta3Module(opts);
    mod.readPatch = readPatch;
    mod.readSource = readSource;
    mod.outputFile = outputFile;
    mod.reportError = reportError;

    const noVer = disableChecksum ? 'true' : 'false';
    const result = mod.callMain([bufferSize.toString(), cacheSize.toString(), noVer]);
    if (result !== 0) {
      postMessage({ type: 'done', error: true, errorCode: result, errorMessage: state.errorMessage || 'Código de erro xdelta: ' + result });
    } else {
      postMessage({ type: 'done', error: false });
    }
  } catch (err) {
    postMessage({ type: 'done', error: true, errorMessage: err.message || String(err) });
  } finally {
    mod = undefined;
  }
};
