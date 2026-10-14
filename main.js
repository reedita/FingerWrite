"use strict";

const canvas = document.getElementById("drawingCanvas");
const canvasWrap = document.getElementById("canvasWrap");
const ctx = canvas.getContext("2d");

const modeLabel = document.getElementById("modeLabel");
const canvasHint = document.getElementById("canvasHint");
const canvasMessage = document.getElementById("canvasMessage");

const colorButtons = document.querySelectorAll(".color-button");
const thicknessSelect = document.getElementById("thicknessSelect");

const undoButton = document.getElementById("undoButton");
const redoButton = document.getElementById("redoButton");
const eraserButton = document.getElementById("eraserButton");
const clearButton = document.getElementById("clearButton");
const exportButton = document.getElementById("exportButton");
const cameraButton = document.getElementById("cameraButton");

const noteList = document.getElementById("noteList");
const noteCount = document.getElementById("noteCount");
const noteTitle = document.getElementById("noteTitle");
const noteContent = document.getElementById("noteContent");
const newNoteButton = document.getElementById("newNoteButton");
const saveNoteButton = document.getElementById("saveNoteButton");
const deleteNoteButton = document.getElementById("deleteNoteButton");
const noteMessage = document.getElementById("noteMessage");

const STORAGE_KEY = "fingerwrite-notes-v1";
const CANVAS_BACKGROUND = "#f8f8f5";
const MAX_HISTORY = 100;

// APPLICATION 

let currentColor = "#202124";
let currentThickness = 4;
let isErasing = false;
let isDrawing = false;

let strokes = [];
let redoStack = [];
let activeStroke = null;

let notes = [];
let activeNoteId = null;
let saveTimer = null;
let resizeTimer = null;
let canvasWidth = 0;
let canvasHeight = 0;

let cameraStream = null;
let handsModel = null;
let cameraRunning = false;
let cameraBusy = false;
let cameraFrameId = null;
let cameraGeneration = 0;

let lastFingerPoint = null;
let smoothedFingerPoint = null;
let penDown = false;
let pinchStartFrames = 0;
let pinchReleaseFrames = 0;
let missingHandFrames = 0;

// Gesture tuning
const PINCH_START_THRESHOLD = 0.30;
const PINCH_END_THRESHOLD = 0.38;
const PINCH_START_FRAMES = 1;
const PINCH_RELEASE_FRAMES = 1;
const MISSING_HAND_GRACE_FRAMES = 5;
const MAX_POINT_DISTANCE = 0.5;
const SHOW_TRACKING_DEBUG = true;

// Writing zone: fraction of the camera width that maps to the canvas
const ZONE_WIDTH = 0.8;

// One Euro filter: smooth when slow, responsive when fast
class OneEuro {
  constructor(minCutoff, beta) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.reset();
  }
  reset() { this.prev = null; this.dxHat = 0; this.t = 0; }
  alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(x, t) {
    if (this.prev === null) { this.prev = x; this.t = t; return x; }
    const dt = Math.max((t - this.t) / 1000, 1 / 120);
    const dx = (x - this.prev) / dt;
    const aD = this.alpha(1.0, dt);
    this.dxHat = aD * dx + (1 - aD) * this.dxHat;
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxHat);
    const a = this.alpha(cutoff, dt);
    this.prev = a * x + (1 - a) * this.prev;
    this.t = t;
    return this.prev;
  }
}
const filterX = new OneEuro(2.0, 25);
const filterY = new OneEuro(2.0, 25);

function cameraToCanvas(px, py) {
  const vw = cameraVideo.videoWidth || 640;
  const vh = cameraVideo.videoHeight || 480;
  const zoneW = ZONE_WIDTH;                                   // fraction of camera width
  const zoneH = (vw * zoneW * (canvasHeight / canvasWidth)) / vh; // same pixel aspect as canvas
  const x = ((1 - px) - (0.5 - zoneW / 2)) / zoneW;           // 1 - px mirrors the image
  const y = (py - (0.5 - zoneH / 2)) / zoneH;
  return {
    x: Math.max(0, Math.min(1, x)),
    y: Math.max(0, Math.min(1, y))
  };
}

const cameraVideo = document.getElementById("cameraVideo");
const fingerCursor = document.getElementById("fingerCursor");

let debugElement = null;
if (SHOW_TRACKING_DEBUG) {
  debugElement = document.createElement("div");
  debugElement.id = "trackingDebug";
  document.body.appendChild(debugElement);
}

// LOCAL STORAGE

function loadNotes() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) {
      notes = [];
      return;
    }
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) {
      throw new Error("Invalid saved notes");
    }
    notes = parsed.filter(note =>
      note &&
      typeof note.id === "string" &&
      typeof note.title === "string" &&
      typeof note.content === "string" &&
      Array.isArray(note.strokes)
    );
  } catch (error) {
    console.error("Could not load notes:", error);
    notes = [];
    noteMessage.textContent =
      "Saved notes could not be loaded. Check browser storage.";
  }
}

function persistNotes() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
    return true;
  } catch (error) {
    console.error("Could not save notes:", error);
    noteMessage.textContent =
      "Storage is full or unavailable. Export your work.";
    return false;
  }
}

function scheduleAutoSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (activeNoteId) {
      saveCurrentNote(true);
    }
  }, 500);
}

// NOTE MANAGEMENT

function createNoteObject(title = "Untitled note") {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title,
    content: "",
    createdAt: now,
    updatedAt: now,
    strokes: [],
    background: CANVAS_BACKGROUND
  };
}

function saveCurrentNote(silent = false) {
  if (!activeNoteId) {
    if (!silent) {
      noteMessage.textContent =
        "Create a note before saving your work.";
    }
    return false;
  }
  const note = notes.find(item => item.id === activeNoteId);
  if (!note) return false;

  const title = noteTitle.value.trim();
  if (!title) {
    noteMessage.textContent = "Please enter a note title.";
    noteTitle.focus();
    return false;
  }

  note.title = title;
  note.content = noteContent.value;
  note.strokes = cloneStrokes(strokes);
  note.background = CANVAS_BACKGROUND;
  note.updatedAt = new Date().toISOString();

  if (!persistNotes()) return false;
  renderNoteList();

  if (!silent) {
    noteMessage.textContent = "Note saved on this device.";
  }
  return true;
}

function openNote(id) {
  if (activeNoteId && !saveCurrentNote(true)) {
    return;
  }
  const note = notes.find(item => item.id === id);
  if (!note) return;

  activeNoteId = note.id;
  strokes = cloneStrokes(note.strokes);
  redoStack = [];

  noteTitle.value = note.title;
  noteContent.value = note.content;

  renderCanvas();
  renderNoteList();
  updateHistoryButtons();
  noteMessage.textContent = "Note opened.";
}

function createNewNote() {
  if (activeNoteId && !saveCurrentNote(true)) {
    return;
  }
  const note = createNoteObject();
  notes.unshift(note);
  activeNoteId = note.id;
  strokes = [];
  redoStack = [];

  noteTitle.value = note.title;
  noteContent.value = note.content;

  persistNotes();
  renderNoteList();
  renderCanvas();
  updateHistoryButtons();

  noteTitle.focus();
  noteTitle.select();
  noteMessage.textContent = "New note created.";
}

function deleteCurrentNote() {
  if (!activeNoteId) return;
  const note = notes.find(item => item.id === activeNoteId);
  if (!note) return;

  const confirmed = confirm(
    `Delete "${note.title}"? This cannot be undone.`
  );
  if (!confirmed) return;

  notes = notes.filter(item => item.id !== activeNoteId);
  activeNoteId = null;
  strokes = [];
  redoStack = [];

  noteTitle.value = "";
  noteContent.value = "";

  persistNotes();

  if (notes.length > 0) {
    openNote(notes[0].id);
  } else {
    renderCanvas();
    renderNoteList();
    updateHistoryButtons();
  }
  noteMessage.textContent = "Note deleted.";
}

function renderNoteList() {
  noteList.replaceChildren();
  noteCount.textContent = String(notes.length);

  if (notes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-notes";
    empty.textContent =
      "Your notebook is empty. Create a note to get started.";
    noteList.appendChild(empty);
    return;
  }

  for (const note of notes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "note-card" + (note.id === activeNoteId ? " active" : "");

    const title = document.createElement("strong");
    title.textContent = note.title;

    const date = document.createElement("span");
    date.textContent = "Edited " + formatDate(note.updatedAt);

    button.append(title, date);
    button.addEventListener("click", () => openNote(note.id));
    noteList.appendChild(button);
  }
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return date.toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function cloneStrokes(items) {
  return items.map(stroke => {
    if (stroke.type === "text") {
      return {
        ...stroke,
        source: cloneStrokes(stroke.source || [])
      };
    }

    return {
      color: stroke.color,
      width: stroke.width,
      points: stroke.points.map(point => ({
        x: point.x,
        y: point.y
      }))
    };
  });
}

//  CANVAS SIZING AND RENDERING

function resizeCanvas() {
  const rect = canvasWrap.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  const newWidth = Math.round(rect.width);
  const newHeight = Math.round(rect.height);
  if (newWidth === canvasWidth && newHeight === canvasHeight) return;

  canvasWidth = newWidth;
  canvasHeight = newHeight;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(canvasWidth * dpr);
  canvas.height = Math.round(canvasHeight * dpr);
  canvas.style.width = `${canvasWidth}px`;
  canvas.style.height = `${canvasHeight}px`;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  renderCanvas();
}

function renderCanvas() {
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  ctx.fillStyle = CANVAS_BACKGROUND;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  for (const stroke of strokes) {
    drawStroke(stroke);
  }

  canvasHint.classList.toggle(
    "hidden",
    strokes.some(stroke => stroke.type === "text" || stroke.points.length > 0)
  );
}

function drawStroke(stroke) {
  if (stroke.type === "text") { drawTextOn(ctx, stroke, canvasWidth, canvasHeight); return; }
  const points = stroke.points;
  if (!points || points.length === 0) return;

  ctx.beginPath();
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const first = points[0];
  const x0 = first.x * canvasWidth;
  const y0 = first.y * canvasHeight;
  ctx.moveTo(x0, y0);

  if (points.length === 1) {
    ctx.arc(x0, y0, stroke.width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  for (let i = 1; i < points.length; i++) {
    const current = points[i];
    const previous = points[i - 1];
    const x = current.x * canvasWidth;
    const y = current.y * canvasHeight;
    const px = previous.x * canvasWidth;
    const py = previous.y * canvasHeight;
    const midX = (px + x) / 2;
    const midY = (py + y) / 2;

    if (i === 1) {
      ctx.lineTo(midX, midY);
    } else {
      ctx.quadraticCurveTo(px, py, midX, midY);
    }
  }

  const last = points[points.length - 1];
  ctx.lineTo(last.x * canvasWidth, last.y * canvasHeight);
  ctx.stroke();
}

// MOUSE AND TOUCHPAD DRAWING

function getCanvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
  };
}

function beginStroke(point) {
  clearTimeout(recognizeTimer);
  if (isDrawing) return;
  isDrawing = true;

  activeStroke = {
    color: isErasing ? CANVAS_BACKGROUND : currentColor,
    width: currentThickness,
    points: [{ x: point.x, y: point.y }]
  };

  strokes.push(activeStroke);
  if (strokes.length > MAX_HISTORY) {
    strokes.shift();
  }
  redoStack = [];

  canvasHint.classList.add("hidden");
  canvasMessage.textContent = "Drawing...";
  renderCanvas();
  updateHistoryButtons();
}

function appendStrokePoint(point) {
  if (!isDrawing || !activeStroke) return;
  const previous = activeStroke.points[activeStroke.points.length - 1];
  const dx = point.x - previous.x;
  const dy = point.y - previous.y;
  if (dx * dx + dy * dy < 0.000002) return;

  activeStroke.points.push({ x: point.x, y: point.y });
  drawStroke(activeStroke);
}

function finishStroke() {
  if (!isDrawing) return;
  isDrawing = false;
  if (activeStroke && !isErasing) pendingStrokes.push(activeStroke);
  activeStroke = null;

  canvasMessage.textContent = cameraRunning
    ? "Air-writing ready"
    : "Ready to draw";

  updateHistoryButtons();
  scheduleAutoSave();
  scheduleRecognition();
}

function startDrawing(event) {
  if (cameraRunning) return;
  if (event.pointerType === "mouse" && event.button !== 0) return;
  if (isDrawing) return;

  canvas.setPointerCapture(event.pointerId);
  beginStroke(getCanvasPoint(event));
}

function continueDrawing(event) {
  if (!isDrawing || cameraRunning) return;
  appendStrokePoint(getCanvasPoint(event));
}

function stopDrawing() {
  if (cameraRunning) return;
  finishStroke();
}

canvas.addEventListener("pointerdown", startDrawing);
canvas.addEventListener("pointermove", continueDrawing);
canvas.addEventListener("pointerup", stopDrawing);
canvas.addEventListener("pointercancel", stopDrawing);
canvas.addEventListener("lostpointercapture", stopDrawing);

// AIR-WRITING: CAMERA AND HAND TRACKING

async function startAirWriting() {
  if (cameraRunning) return;

  if (!navigator.mediaDevices?.getUserMedia) {
    showCameraError(
      "Camera access is unavailable. Use mouse mode or open the app through localhost."
    );
    return;
  }

  if (typeof Hands === "undefined") {
    showCameraError(
      "Hand-tracking files could not load. Check your internet connection and refresh."
    );
    return;
  }

  cameraButton.disabled = true;
  cameraButton.textContent = "Starting camera...";
  const generation = ++cameraGeneration;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: "user",
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 24, max: 30 }
      }
    });

    if (generation !== cameraGeneration) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }

    cameraStream = stream;
    cameraVideo.srcObject = stream;
    await cameraVideo.play();

    if (generation !== cameraGeneration) return;

    handsModel = new Hands({
      locateFile: file =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
    });

    handsModel.setOptions({
      maxNumHands: 1,
      modelComplexity: 0,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.6
    });

    handsModel.onResults(results => {
      if (!cameraRunning || generation !== cameraGeneration) return;
      handleHandResults(results);
    });

    cameraRunning = true;
    modeLabel.textContent = "Air-writing active";
    cameraButton.textContent = "Stop Air-Writing";
    cameraButton.classList.add("camera-active");
    canvasMessage.textContent = "Show your hand to the camera";

    cameraFrameId = requestAnimationFrame(
      () => processCameraFrame(generation)
    );

  } catch (error) {
    console.error("Could not start air-writing:", error);
    if (generation === cameraGeneration) {
      await stopAirWriting();
      showCameraError(
        error.name === "NotAllowedError"
          ? "Camera permission was denied. You can continue using mouse mode."
          : error.name === "NotFoundError"
            ? "No webcam was found. You can continue using mouse mode."
            : "The camera could not start. Close other camera apps and try again."
      );
    }
  } finally {
    cameraButton.disabled = false;
    if (!cameraRunning) {
      cameraButton.textContent = "Enable Air-Writing";
    }
  }
}

async function processCameraFrame(generation) {
  if (!cameraRunning || generation !== cameraGeneration || !handsModel) {
    return;
  }

  if (!cameraBusy && cameraVideo.readyState >= 2) {
    cameraBusy = true;
    try {
      await handsModel.send({ image: cameraVideo });
    } catch (error) {
      console.error("Hand tracking failed:", error);
      if (cameraRunning) {
        canvasMessage.textContent =
          "Tracking paused briefly. Keep your hand visible.";
      }
    } finally {
      cameraBusy = false;
    }
  }

  if (cameraRunning && generation === cameraGeneration) {
    cameraFrameId = requestAnimationFrame(
      () => processCameraFrame(generation)
    );
  }
}

function handleHandResults(results) {
  const hand = results.multiHandLandmarks?.[0];

  if (!hand) {
    missingHandFrames++;

    if (missingHandFrames <= MISSING_HAND_GRACE_FRAMES) {
      return;
    }

    // Hand lost for too long: release pen and hide cursor
    penDown = false;
    pinchStartFrames = 0;
    pinchReleaseFrames = 0;
    lastFingerPoint = null;
    smoothedFingerPoint = null;
    filterX.reset(); filterY.reset();

    finishStroke();
    fingerCursor.classList.remove("visible", "down");

    canvasMessage.textContent =
      "Hand not detected — show your hand to the camera";

    if (debugElement) {
      debugElement.textContent = "No hand";
    }
    return;
  }

  missingHandFrames = 0;

  const tip = hand[8];
  const wrist = hand[0];
  const middleMcp = hand[9];
  const thumbTip = hand[4];

  const palmScale = Math.hypot(
    middleMcp.x - wrist.x,
    middleMcp.y - wrist.y
  );

  if (palmScale < 0.0001) return;

    const pinchDistance = Math.hypot(
    thumbTip.x - tip.x,
    thumbTip.y - tip.y,
    thumbTip.z - tip.z
  ) / palmScale;

  // Pen sits between thumb and index, so pinching doesn't move it
  const penX = (tip.x + thumbTip.x) / 2;
  const penY = (tip.y + thumbTip.y) / 2;

  const target = cameraToCanvas(penX, penY);
  const now = performance.now();
  smoothedFingerPoint = {
    x: filterX.filter(target.x, now),
    y: filterY.filter(target.y, now)
  };
  lastFingerPoint = smoothedFingerPoint;

  fingerCursor.style.left = `${lastFingerPoint.x * canvas.clientWidth}px`;
  fingerCursor.style.top = `${lastFingerPoint.y * canvas.clientHeight}px`;
  fingerCursor.classList.add("visible");
  fingerCursor.classList.toggle("down", penDown);

  if (debugElement) {
    debugElement.textContent =
      `pinch: ${pinchDistance.toFixed(3)}  pen: ${penDown ? "DOWN" : "UP"}\n` +
      `pos: ${lastFingerPoint.x.toFixed(2)}, ${lastFingerPoint.y.toFixed(2)}`;
  }

  // Pinch hold to draw, release to lift
  if (!penDown) {
    if (pinchDistance < PINCH_START_THRESHOLD) {
      pinchStartFrames++;
      if (pinchStartFrames >= PINCH_START_FRAMES) {
        penDown = true;
        pinchStartFrames = 0;
        pinchReleaseFrames = 0;
        if (smoothedFingerPoint) {
          beginStroke(smoothedFingerPoint);
        }
      }
    } else {
      pinchStartFrames = 0;
    }
  } else {
    if (pinchDistance > PINCH_END_THRESHOLD) {
      pinchReleaseFrames++;
      if (pinchReleaseFrames >= PINCH_RELEASE_FRAMES) {
        penDown = false;
        pinchReleaseFrames = 0;
        pinchStartFrames = 0;
        finishStroke();
      }
    } else {
      pinchReleaseFrames = 0;
    }
  }

  // Draw if pen is down
  if (penDown && smoothedFingerPoint) {
    if (!isDrawing) {
      beginStroke(smoothedFingerPoint);
    } else {
      const lastPoint = activeStroke.points[activeStroke.points.length - 1];
      const dist = Math.hypot(
        smoothedFingerPoint.x - lastPoint.x,
        smoothedFingerPoint.y - lastPoint.y
      );
      if (dist > MAX_POINT_DISTANCE) {
        finishStroke();
        beginStroke(smoothedFingerPoint);
      } else {
        appendStrokePoint(smoothedFingerPoint);
      }
    }
    canvasMessage.textContent = "Pen down — release pinch to stop writing";
  } else {
    canvasMessage.textContent = "Pinch and hold to start writing";
  }
}

async function stopAirWriting() {
  cameraGeneration++;
  cameraRunning = false;

  if (cameraFrameId !== null) {
    cancelAnimationFrame(cameraFrameId);
    cameraFrameId = null;
  }

  penDown = false;
  pinchStartFrames = 0;
  pinchReleaseFrames = 0;
  missingHandFrames = 0;
  lastFingerPoint = null;
  smoothedFingerPoint = null;
  filterX.reset(); filterY.reset();

  finishStroke();
  fingerCursor.classList.remove("visible", "down");

  if (debugElement) {
    debugElement.textContent = "";
  }

  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }

  cameraVideo.srcObject = null;

  const oldModel = handsModel;
  handsModel = null;

  if (oldModel) {
    try {
      await oldModel.close();
    } catch (error) {
      console.warn("Hand tracker cleanup:", error);
    }
  }

  cameraBusy = false;
  modeLabel.textContent = "Mouse mode";
  cameraButton.textContent = "Enable Air-Writing";
  cameraButton.classList.remove("camera-active");
  canvasMessage.textContent = "Camera stopped — mouse mode ready";
}

function showCameraError(message) {
  canvasMessage.textContent = message;
  noteMessage.textContent = message;
  modeLabel.textContent = "Mouse mode";
  fingerCursor.classList.remove("visible", "down");
}
// COLORS, THICKNESS AND ERASER

colorButtons.forEach(button => {
  button.addEventListener("click", () => {
    currentColor = button.dataset.color;
    isErasing = false;

    colorButtons.forEach(item => {
      const selected = item === button;
      item.classList.toggle("selected", selected);
      item.setAttribute("aria-pressed", String(selected));
    });

    eraserButton.setAttribute("aria-pressed", "false");
    canvasMessage.textContent = "Ink color changed";
  });
});

thicknessSelect.addEventListener("change", () => {
  currentThickness = Number(thicknessSelect.value);
});

eraserButton.addEventListener("click", () => {
  isErasing = !isErasing;
  eraserButton.setAttribute("aria-pressed", String(isErasing));
  canvasMessage.textContent = isErasing ? "Eraser active" : "Pen active";
});

// UNDO, REDO AND CLEAR

function updateHistoryButtons() {
  undoButton.disabled = strokes.length === 0;
  redoButton.disabled = redoStack.length === 0;
}

undoButton.addEventListener("click", () => {
  if (strokes.length === 0) return;
  const removed = strokes.pop();
  if (removed.type === "text") {
    strokes.push(...removed.source);   // bring your handwriting back
    const at = recognizedText.value.lastIndexOf(removed.text);
    if (at !== -1) {
      recognizedText.value = (recognizedText.value.slice(0, at) +
        recognizedText.value.slice(at + removed.text.length)).trim();
    }
  } else {
    redoStack.push(removed);
  }
  renderCanvas();
  updateHistoryButtons();
  scheduleAutoSave();
  canvasMessage.textContent = "Last stroke undone";
});

redoButton.addEventListener("click", () => {
  if (redoStack.length === 0) return;
  strokes.push(redoStack.pop());
  renderCanvas();
  updateHistoryButtons();
  scheduleAutoSave();
  canvasMessage.textContent = "Stroke restored";
});

clearButton.addEventListener("click", () => {
  if (strokes.length === 0) return;
  if (!confirm("Clear all strokes on this note?")) return;

  strokes = [];
  redoStack = [];
  renderCanvas();
  updateHistoryButtons();
  scheduleAutoSave();
  canvasMessage.textContent = "Canvas cleared";
});

// EXPORT DRAWING AS PNG

exportButton.addEventListener("click", () => {
  try {
    const output = document.createElement("canvas");
    const scale = 2;
    output.width = canvasWidth * scale;
    output.height = canvasHeight * scale;

    const outputCtx = output.getContext("2d");
    outputCtx.scale(scale, scale);
    outputCtx.fillStyle = CANVAS_BACKGROUND;
    outputCtx.fillRect(0, 0, canvasWidth, canvasHeight);

    for (const stroke of strokes) {
      if (stroke.type === "text") { drawTextOn(outputCtx, stroke, canvasWidth, canvasHeight); continue; }
      const points = stroke.points;
      if (!points.length) continue;

      outputCtx.beginPath();
      outputCtx.strokeStyle = stroke.color;
      outputCtx.fillStyle = stroke.color;
      outputCtx.lineWidth = stroke.width;
      outputCtx.lineCap = "round";
      outputCtx.lineJoin = "round";

      const first = points[0];
      const x0 = first.x * canvasWidth;
      const y0 = first.y * canvasHeight;
      outputCtx.moveTo(x0, y0);

      if (points.length === 1) {
        outputCtx.arc(x0, y0, stroke.width / 2, 0, Math.PI * 2);
        outputCtx.fill();
        continue;
      }

      for (let i = 1; i < points.length; i++) {
        const prev = points[i - 1];
        const curr = points[i];
        const px = prev.x * canvasWidth;
        const py = prev.y * canvasHeight;
        const x = curr.x * canvasWidth;
        const y = curr.y * canvasHeight;
        outputCtx.quadraticCurveTo(
          px, py, (px + x) / 2, (py + y) / 2
        );
      }

      const last = points[points.length - 1];
      outputCtx.lineTo(last.x * canvasWidth, last.y * canvasHeight);
      outputCtx.stroke();
    }

    const link = document.createElement("a");
    link.download = "fingerwrite-drawing.png";
    link.href = output.toDataURL("image/png");
    link.click();
    canvasMessage.textContent = "PNG export started";
  } catch (error) {
    console.error("PNG export failed:", error);
    canvasMessage.textContent = "Could not export this drawing.";
  }
});

// NOTE EDIT

newNoteButton.addEventListener("click", createNewNote);
saveNoteButton.addEventListener("click", () => saveCurrentNote(false));
deleteNoteButton.addEventListener("click", deleteCurrentNote);
noteTitle.addEventListener("input", scheduleAutoSave);
noteContent.addEventListener("input", scheduleAutoSave);

window.addEventListener("beforeunload", () => {
  clearTimeout(saveTimer);
  if (activeNoteId) {
    saveCurrentNote(true);
  }
});

// CAMERA BUTTON

cameraButton.addEventListener("click", async () => {
  if (cameraRunning) {
    await stopAirWriting();
  } else {
    await startAirWriting();
  }
});

// HANDWRITING RECOGNITION

const recognizeToggle = document.getElementById("recognizeToggle");
const recognizedText = document.getElementById("recognizedText");
const suggestionsBox = document.getElementById("suggestions");
const recognitionStatus = document.getElementById("recognitionStatus");
const addToNoteButton = document.getElementById("addToNoteButton");

const PAUSE_BEFORE_RECOGNIZE_MS = 1800;
const WORD_LIST_URL = "https://cdn.jsdelivr.net/npm/word-list/words.txt";

let pendingStrokes = [];
let recognizeTimer = null;
let ocrWorker = null;
let wordSet = null;
let wordsByLength = null;


// Replace the ink with a typed text item
function commitText(batch, text, box) {
  const item = {
    type: "text",
    text,
    x: box.x / canvasWidth,
    y: box.y / canvasHeight,
    w: box.w / canvasWidth,
    h: box.h / canvasHeight,
    color: batch[0].color,
    source: batch
  };
  strokes = strokes.filter(s => !batch.includes(s));
  strokes.push(item);
  redoStack = [];
  pendingStrokes = pendingStrokes.filter(s => !batch.includes(s));

  recognizedText.value = (recognizedText.value + " " + text).trim();
  renderCanvas();
  updateHistoryButtons();
  scheduleAutoSave();
  showSuggestions(item);
  if (pendingStrokes.length) scheduleRecognition();
}

function drawTextOn(c, item, W, H) {
  const bw = item.w * W, bh = item.h * H;
  c.save();
  c.fillStyle = item.color;
  c.font = '600 100px Inter, "Segoe UI", Arial, sans-serif';
  const widthAt100 = c.measureText(item.text).width || 1;
  let size = Math.min((bw / widthAt100) * 100, bh * 1.5);
  size = Math.max(18, Math.min(size, 120));
  c.font = `600 ${size}px Inter, "Segoe UI", Arial, sans-serif`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText(item.text, item.x * W + bw / 2, item.y * H + bh / 2);
  c.restore();
}

// Spelling suggestions and corrections

async function loadWordList() {
  if (wordSet) return;
  try {
    const res = await fetch(WORD_LIST_URL);
    const all = (await res.text()).split(/\r?\n/);
    wordSet = new Set(all);
    wordsByLength = {};
    for (const w of all) {
      if (w.length < 2 || w.length > 14) continue;
      (wordsByLength[w.length] ||= []).push(w);
    }
  } catch (error) {
    console.warn("Word list unavailable:", error);
  }
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(
        row[j] + 1, row[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      prev = tmp;
    }
  }
  return row[b.length];
}

function suggestWords(word) {
  const lower = word.toLowerCase();
  const maxDist = lower.length <= 4 ? 1 : 2;
  const found = [];
  for (let len = lower.length - 1; len <= lower.length + 1; len++) {
    for (const cand of wordsByLength[len] || []) {
      const d = editDistance(lower, cand);
      if (d <= maxDist) found.push({ cand, d });
    }
  }
  found.sort((a, b) => a.d - b.d);
  const capital = word[0] === word[0].toUpperCase();
  return found.slice(0, 5).map(f =>
    capital ? f.cand[0].toUpperCase() + f.cand.slice(1) : f.cand
  );
}

function makeChip(label, onClick, extraClass = "") {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "suggestion-chip " + extraClass;
  chip.textContent = label;
  chip.addEventListener("click", onClick);
  return chip;
}

async function showSuggestions(item) {
  suggestionsBox.replaceChildren();
  await loadWordList();

  if (wordSet) {
    const words = item.text.split(" ");
    const idx = words.findIndex(w =>
      /^[A-Za-z]+$/.test(w) && w.length > 1 && !wordSet.has(w.toLowerCase())
    );
    if (idx !== -1) {
      const label = document.createElement("span");
      label.className = "suggestions-label";
      label.textContent = "DID YOU MEAN";
      suggestionsBox.appendChild(label);
      for (const option of suggestWords(words[idx])) {
        const fixed = words.slice();
        fixed[idx] = option;
        suggestionsBox.appendChild(
          makeChip(option, () => applyCorrection(item, fixed.join(" ")), "suggestion-spell")
        );
      }
    }
  }
  suggestionsBox.appendChild(makeChip("✎ Edit", () => {
    const typed = prompt("Fix the text:", item.text);
    if (typed && typed.trim()) applyCorrection(item, typed.trim());
  }));
}

function applyCorrection(item, newText) {
  learnFromCorrection(item, newText);
  const old = item.text;
  const at = recognizedText.value.lastIndexOf(old);
  if (at !== -1) {
    recognizedText.value =
      recognizedText.value.slice(0, at) + newText +
      recognizedText.value.slice(at + old.length);
  }
  item.text = newText;
  renderCanvas();
  scheduleAutoSave();
  showSuggestions(item);
}

addToNoteButton.addEventListener("click", () => {
  const text = recognizedText.value.trim();
  if (!text) return;
  noteContent.value = (noteContent.value.trim() + "\n" + text).trim();
  recognizedText.value = "";
  suggestionsBox.replaceChildren();
  scheduleAutoSave();
  noteMessage.textContent = "Text added to your note.";
});

// PERSONAL HANDWRITING RECOGNIZER (learns from your own letters)
 
const trainToggle = document.getElementById("trainToggle");
const trainSet = document.getElementById("trainSet");
const trainPrompt = document.getElementById("trainPrompt");
const trainStatus = document.getElementById("trainStatus");
const trainSaveButton = document.getElementById("trainSaveButton");
const trainBackButton = document.getElementById("trainBackButton");
const trainResetButton = document.getElementById("trainResetButton");
 
const TEMPLATE_KEY = "fingerwrite-templates-v1";
const CLOUD_POINTS = 32;      // each letter is reduced to this many points
const SPACE_GAP = 0.5;        // gap bigger than 50% of line height = a space
const TRAIN_PAUSE_MS = 1000;  // pause that auto-saves a training letter
const TRAIN_ROUNDS = 2;       // how many times you write each letter
 
let templates = [];           // [{ label: "A", cloud: [...] }]
let trainIndex = 0;
 
function loadTemplates() {
  try {
    const saved = JSON.parse(localStorage.getItem(TEMPLATE_KEY) || "[]");
    templates = Array.isArray(saved) ? saved : [];
  } catch (error) {
    templates = [];
  }
}
 
function saveTemplates() {
  try {
    localStorage.setItem(TEMPLATE_KEY, JSON.stringify(templates));
  } catch (error) {
    console.warn("Could not save letter samples:", error);
  }
}
 
// Step A: split strokes into letters
 
function groupLetters(items) {
  const boxes = items.map(s => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of s.points) {
      const x = p.x * canvasWidth, y = p.y * canvasHeight;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    return { strokes: [s], x0, y0, x1, y1 };
  }).sort((a, b) => a.x0 - b.x0);
 
  const lineH = Math.max(1,
    Math.max(...boxes.map(b => b.y1)) - Math.min(...boxes.map(b => b.y0)));
 
  const letters = [];
  for (const b of boxes) {
    const last = letters[letters.length - 1];
    if (last) {
      const overlap = last.x1 - b.x0;               // negative = a gap
      const narrow = Math.min(last.x1 - last.x0, b.x1 - b.x0);
      const strongOverlap = overlap > 0 && overlap >= 0.3 * narrow;
      const thinAndClose = narrow < 0.25 * lineH && overlap > -0.04 * lineH;
      if (strongOverlap || thinAndClose) {
        last.strokes.push(...b.strokes);
        last.x1 = Math.max(last.x1, b.x1);
        last.y0 = Math.min(last.y0, b.y0);
        last.y1 = Math.max(last.y1, b.y1);
        continue;
      }
    }
    letters.push(b);
  }
 
  const box = {
    x: Math.min(...letters.map(l => l.x0)),
    y: Math.min(...letters.map(l => l.y0)),
    w: 0,
    h: 0
  };
  box.w = Math.max(...letters.map(l => l.x1)) - box.x;
  box.h = Math.max(1, Math.max(...letters.map(l => l.y1)) - box.y);
  return { letters, box, H: box.h };
}
 
// Step B: turn a letter into a small, size-independent shape
 
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
 
function resample(points, n) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].id === points[i - 1].id) total += dist(points[i - 1], points[i]);
  }
  if (total < 1e-6) return Array.from({ length: n }, () => ({ ...points[0] }));
 
  const step = total / (n - 1);
  const pts = points.map(p => ({ ...p }));
  const out = [{ ...pts[0] }];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].id !== pts[i - 1].id) continue;
    const d = dist(pts[i - 1], pts[i]);
    if (d === 0) continue;
    if (acc + d >= step) {
      const t = (step - acc) / d;
      const q = {
        x: pts[i - 1].x + t * (pts[i].x - pts[i - 1].x),
        y: pts[i - 1].y + t * (pts[i].y - pts[i - 1].y),
        id: pts[i].id
      };
      out.push(q);
      pts.splice(i, 0, q);
      acc = 0;
    } else {
      acc += d;
    }
  }
  while (out.length < n) out.push({ ...pts[pts.length - 1] });
  return out.slice(0, n);
}
 
function toCloud(letterStrokes) {
  let pts = [];
  letterStrokes.forEach((s, id) => {
    for (const p of s.points) {
      pts.push({ x: p.x * canvasWidth, y: p.y * canvasHeight, id });
    }
  });
  pts = resample(pts, CLOUD_POINTS);
 
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  const size = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY) || 1;
  pts = pts.map(p => ({ x: (p.x - minX) / size, y: (p.y - minY) / size }));
 
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return pts.map(p => ({
    x: +(p.x - cx).toFixed(4),
    y: +(p.y - cy).toFixed(4)
  }));
}
 
// Step C: compare a letter with your saved samples
 
function cloudDistance(a, b, start) {
  const n = a.length;
  const used = new Array(n).fill(false);
  let sum = 0, i = start;
  do {
    let best = Infinity, index = -1;
    for (let j = 0; j < n; j++) {
      if (!used[j]) {
        const d = dist(a[i], b[j]);
        if (d < best) { best = d; index = j; }
      }
    }
    used[index] = true;
    sum += (1 - ((i - start + n) % n) / n) * best;
    i = (i + 1) % n;
  } while (i !== start);
  return sum;
}
 
function matchDistance(a, b) {
  const step = Math.floor(Math.sqrt(a.length));
  let best = Infinity;
  for (let i = 0; i < a.length; i += step) {
    best = Math.min(best, cloudDistance(a, b, i), cloudDistance(b, a, i));
  }
  return best;
}
 
function classify(cloud) {
  const best = {};
  for (const t of templates) {
    const d = matchDistance(cloud, t.cloud);
    if (best[t.label] === undefined || d < best[t.label]) best[t.label] = d;
  }
  return Object.entries(best).sort((a, b) => a[1] - b[1]);
}
 
// Step D: recognition flow
 
function scheduleRecognition() {
  clearTimeout(recognizeTimer);
  if (pendingStrokes.length === 0) return;
  if (trainToggle.checked) {
    recognizeTimer = setTimeout(saveTrainingSample, TRAIN_PAUSE_MS);
    return;
  }
  if (!recognizeToggle.checked) return;
  recognitionStatus.textContent = "Pause detected. Reading...";
  recognizeTimer = setTimeout(recognizePending, PAUSE_BEFORE_RECOGNIZE_MS);
}
 
function recognizePending() {
  pendingStrokes = pendingStrokes.filter(s => strokes.includes(s));
  if (pendingStrokes.length === 0) return;
  if (templates.length === 0) {
    recognitionStatus.textContent =
      "Teach it your handwriting first: turn on TRAINING below.";
    return;
  }
 
  const batch = pendingStrokes.slice();
  const { letters, box, H } = groupLetters(batch);
  const clouds = [];
  let text = "";
  letters.forEach((letter, i) => {
    if (i > 0 && letter.x0 - letters[i - 1].x1 > SPACE_GAP * H) text += " ";
    const cloud = toCloud(letter.strokes);
    clouds.push(cloud);
    text += classify(cloud)[0][0];
  });
 
  commitText(batch, text, box);
  strokes[strokes.length - 1].letterClouds = clouds;
  recognitionStatus.textContent =
    "Done. Wrong letter? Use the chips or ✎ Edit. It learns from your fixes.";
}
 
// It learns when you correct it
 
function learnFromCorrection(item, newText) {
  if (!item.letterClouds) return;
  const oldChars = item.text.replace(/ /g, "");
  const newChars = newText.replace(/ /g, "");
  if (oldChars.length !== newChars.length ||
      oldChars.length !== item.letterClouds.length) return;
  let learned = false;
  for (let i = 0; i < newChars.length; i++) {
    if (newChars[i] !== oldChars[i]) {
      templates.push({ label: newChars[i], cloud: item.letterClouds[i] });
      learned = true;
    }
  }
  if (learned) saveTemplates();
}
 
// Training mode
 
function trainSequence() {
  let seq = [];
  for (let r = 0; r < TRAIN_ROUNDS; r++) seq = seq.concat(trainSet.value.split(""));
  return seq;
}
 
function updateTrainPrompt() {
  const seq = trainSequence();
  if (!trainToggle.checked) {
    trainPrompt.textContent = "";
    trainStatus.textContent = `Letter samples saved: ${templates.length}`;
  } else if (trainIndex >= seq.length) {
    trainPrompt.textContent = "✓";
    trainStatus.textContent =
      "This set is done. Pick another set, or turn training off.";
  } else {
    trainPrompt.textContent = seq[trainIndex];
    trainStatus.textContent =
      `Write "${seq[trainIndex]}" (${trainIndex + 1}/${seq.length}). ` +
      `Samples saved: ${templates.length}`;
  }
}
 
function saveTrainingSample() {
  pendingStrokes = pendingStrokes.filter(s => strokes.includes(s));
  const seq = trainSequence();
  if (pendingStrokes.length === 0 || trainIndex >= seq.length) return;
 
  const { letters } = groupLetters(pendingStrokes);
  const used = pendingStrokes.slice();
  strokes = strokes.filter(s => !used.includes(s));
  pendingStrokes = [];
  renderCanvas();
  updateHistoryButtons();
 
  if (letters.length !== 1) {
    trainStatus.textContent =
      "That looked like more than one letter. Write just one, then pause.";
    return;
  }
  templates.push({ label: seq[trainIndex], cloud: toCloud(letters[0].strokes) });
  saveTemplates();
  trainIndex++;
  updateTrainPrompt();
}
 
trainToggle.addEventListener("change", () => {
  clearTimeout(recognizeTimer);
  pendingStrokes = [];
  trainIndex = 0;
  updateTrainPrompt();
});
trainSet.addEventListener("change", () => { trainIndex = 0; updateTrainPrompt(); });
trainSaveButton.addEventListener("click", () => {
  clearTimeout(recognizeTimer);
  saveTrainingSample();
});
trainBackButton.addEventListener("click", () => {
  if (trainIndex > 0 && templates.length > 0) {
    templates.pop();
    saveTemplates();
    trainIndex--;
    updateTrainPrompt();
  }
});
trainResetButton.addEventListener("click", () => {
  if (!confirm("Delete all saved letter samples?")) return;
  templates = [];
  saveTemplates();
  trainIndex = 0;
  updateTrainPrompt();
});
 
// INITIALIZE 
function initializeApp() {
  loadTemplates();
  updateTrainPrompt();
  loadWordList();
  loadNotes();
  resizeCanvas();

  if (notes.length > 0) {
    openNote(notes[0].id);
  } else {
    renderCanvas();
    renderNoteList();
    updateHistoryButtons();
  }

  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resizeCanvas, 100);
  });

  modeLabel.textContent = "Mouse mode";
}

initializeApp();
