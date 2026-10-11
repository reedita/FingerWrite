
"use strict";

// ========================================
// 1. FIND THE HTML ELEMENTS
// ========================================

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


// ========================================
// 2. APPLICATION STATE
// ========================================

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
let pinchIsActive = false;

const PINCH_START_THRESHOLD = 0.30;
const PINCH_END_THRESHOLD = 0.42;

const PINCH_START_FRAMES = 3;
const PINCH_RELEASE_FRAMES = 4;
const MISSING_HAND_GRACE_FRAMES = 3;
let penEnabled = false;
let pinchStartFrames = 0;
let pinchReleaseFrames = 0;
let missingHandFrames = 0;
let pinchWasDetected = false;

const FINGER_SMOOTHING = 0.20;

const cameraVideo = document.getElementById("cameraVideo");
const fingerCursor = document.getElementById("fingerCursor");


// ========================================
// 3. LOCAL STORAGE
// ========================================

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


// ========================================
// 4. NOTE MANAGEMENT
// ========================================

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
  // Save the previous note before switching.
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

  // Open another saved note if one exists.
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
      "note-card" +
      (note.id === activeNoteId ? " active" : "");

    const title = document.createElement("strong");
    title.textContent = note.title;

    const date = document.createElement("span");
    date.textContent =
      "Edited " + formatDate(note.updatedAt);

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
  return items.map(stroke => ({
    color: stroke.color,
    width: stroke.width,
    points: stroke.points.map(point => ({
      x: point.x,
      y: point.y
    }))
  }));
}


// ========================================
// 5. CANVAS SIZING AND RENDERING
// ========================================

function resizeCanvas() {
  const rect = canvasWrap.getBoundingClientRect();

  if (rect.width <= 0 || rect.height <= 0) return;

  const newWidth = Math.round(rect.width);
  const newHeight = Math.round(rect.height);

  if (
    newWidth === canvasWidth &&
    newHeight === canvasHeight
  ) {
    return;
  }

  canvasWidth = newWidth;
  canvasHeight = newHeight;

  // Scale the internal canvas for sharper rendering.
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
    strokes.some(stroke => stroke.points.length > 0)
  );
}

function drawStroke(stroke) {
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
    // A tap should still create a visible dot.
    ctx.arc(x0, y0, stroke.width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  // Midpoint-based quadratic interpolation smooths the ink.
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

  ctx.lineTo(
    last.x * canvasWidth,
    last.y * canvasHeight
  );

  ctx.stroke();
}


// ========================================
// 6. MOUSE AND TOUCHPAD DRAWING
// ========================================


function getCanvasPoint(event) {
  const rect = canvas.getBoundingClientRect();

  return {
    x: Math.max(0, Math.min(
      1, (event.clientX - rect.left) / rect.width
    )),
    y: Math.max(0, Math.min(
      1, (event.clientY - rect.top) / rect.height
    ))
  };
}

// Shared drawing function for mouse and webcam input.
function beginStroke(point) {
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

  const previous =
    activeStroke.points[activeStroke.points.length - 1];

  const dx = point.x - previous.x;
  const dy = point.y - previous.y;

  if (dx * dx + dy * dy < 0.000002) return;

  activeStroke.points.push({
    x: point.x,
    y: point.y
  });

  drawStroke(activeStroke);
}

function finishStroke() {
  if (!isDrawing) return;

  isDrawing = false;
  activeStroke = null;

  canvasMessage.textContent = cameraRunning
    ? "Air-writing ready"
    : "Ready to draw";

  updateHistoryButtons();
  scheduleAutoSave();
}

// Mouse and touchpad input.
function startDrawing(event) {
  if (cameraRunning) return;

  if (event.pointerType === "mouse" && event.button !== 0) {
    return;
  }

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


/* ========================================
   AIR-WRITING: CAMERA AND HAND TRACKING
======================================== */

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
    // Ask for permission only after the button is clicked.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: "user",
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 24, max: 30 }
      }
    });

    // If the request completed after cancellation, release it.
    if (generation !== cameraGeneration) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }

    cameraStream = stream;
    cameraVideo.srcObject = stream;

    await cameraVideo.play();

    if (generation !== cameraGeneration) return;

    // Create MediaPipe locally in the browser.
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
      if (
        !cameraRunning ||
        generation !== cameraGeneration
      ) {
        return;
      }

      handleHandResults(results);
    });

    cameraRunning = true;
    modeLabel.textContent = "Air-writing active";
    cameraButton.textContent = "Stop Air-Writing";
    cameraButton.classList.add("camera-active");
    canvasMessage.textContent =
      "Show your hand to the camera";

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
  if (
    !cameraRunning ||
    generation !== cameraGeneration ||
    !handsModel
  ) {
    return;
  }

  // Do not queue multiple hand-tracking requests.
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

  if (
    cameraRunning &&
    generation === cameraGeneration
  ) {
    cameraFrameId = requestAnimationFrame(
      () => processCameraFrame(generation)
    );
  }
}

function handleHandResults(results) {
  const hand = results.multiHandLandmarks?.[0];

  if (!hand) {
  missingHandFrames++;

  // Ignore brief tracking glitches.
  if (missingHandFrames <= MISSING_HAND_GRACE_FRAMES) {
    return;
  }

  pinchIsActive = false;
  pinchStartFrames = 0;
  pinchReleaseFrames = 0;
  lastFingerPoint = null;
  smoothedFingerPoint = null;

  finishStroke();
  fingerCursor.classList.remove("visible");

  canvasMessage.textContent =
    "Hand not detected — show your hand to the camera";

  return;
}

missingHandFrames = 0;

  // MediaPipe landmark 8 = index fingertip.
  const tip = hand[8];

  // Use the wrist-to-middle-finger knuckle distance
  // to normalize the pinch for different hand sizes.
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
    thumbTip.y - tip.y
  ) / palmScale;

  // Mirror horizontal movement for a natural selfie-style
  // interaction. The video itself is never displayed.
  const target = {
    x: Math.max(0, Math.min(1, 1 - tip.x)),
    y: Math.max(0, Math.min(1, tip.y))
  };

  // Smooth small tracking fluctuations.
  if (!smoothedFingerPoint) {
    smoothedFingerPoint = target;
  } else {
    smoothedFingerPoint = {
      x: smoothedFingerPoint.x +
        FINGER_SMOOTHING *
        (target.x - smoothedFingerPoint.x),
      y: smoothedFingerPoint.y +
        FINGER_SMOOTHING *
        (target.y - smoothedFingerPoint.y)
    };
  }

  lastFingerPoint = smoothedFingerPoint;

  // The cursor follows the index fingertip even when
  // the virtual pen is lifted.
  fingerCursor.style.left =
    `${lastFingerPoint.x * canvas.clientWidth}px`;

  fingerCursor.style.top =
    `${lastFingerPoint.y * canvas.clientHeight}px`;

  fingerCursor.classList.add("visible");

  // Require several consistent frames before changing pen state.

  // Pinch once to lower the pen; pinch again to lift it.
  if (pinchDistance < PINCH_START_THRESHOLD) {
    pinchStartFrames++;

    if (
      pinchStartFrames >= PINCH_START_FRAMES &&
      !pinchWasDetected
    ) {
      pinchWasDetected = true;
      penEnabled = !penEnabled;
      pinchStartFrames = 0;

      if (!penEnabled) {
        finishStroke();
      }
    }
  } else {
    pinchStartFrames = 0;
    pinchWasDetected = false;
  }

  // Draw continuously only while the pen is down.
  if (penEnabled && lastFingerPoint) {
    if (!isDrawing) {
      beginStroke(lastFingerPoint);
    } else {
      appendStrokePoint(lastFingerPoint);
    }

    canvasMessage.textContent =
      "Pen down — pinch again to stop writing";
  } else {
    canvasMessage.textContent =
      "Pen up — pinch to start writing";
  }
}

async function stopAirWriting() {
  // Invalidate pending frames and callbacks first.
  cameraGeneration++;
  cameraRunning = false;

  if (cameraFrameId !== null) {
    cancelAnimationFrame(cameraFrameId);
    cameraFrameId = null;
  }

  pinchIsActive = false;
  penEnabled = false;
  pinchStartFrames = 0;
  pinchWasDetected = false;
  lastFingerPoint = null;
  smoothedFingerPoint = null;

  finishStroke();

  fingerCursor.classList.remove("visible");

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
  fingerCursor.classList.remove("visible");
}

// ========================================
// 7. COLORS, THICKNESS AND ERASER
// ========================================

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

  eraserButton.setAttribute(
    "aria-pressed",
    String(isErasing)
  );

  canvasMessage.textContent = isErasing
    ? "Eraser active"
    : "Pen active";
});


// ========================================
// 8. UNDO, REDO AND CLEAR
// ========================================

function updateHistoryButtons() {
  undoButton.disabled = strokes.length === 0;
  redoButton.disabled = redoStack.length === 0;
}

undoButton.addEventListener("click", () => {
  if (strokes.length === 0) return;

  redoStack.push(strokes.pop());

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


// ========================================
// 9. EXPORT DRAWING AS PNG
// ========================================

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

    // Export saved strokes independently of the display canvas.
    for (const stroke of strokes) {
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
        outputCtx.arc(
          x0, y0, stroke.width / 2, 0, Math.PI * 2
        );
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

      outputCtx.lineTo(
        last.x * canvasWidth,
        last.y * canvasHeight
      );

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


// ========================================
// 10. NOTE EDITOR EVENTS
// ========================================

newNoteButton.addEventListener("click", createNewNote);

saveNoteButton.addEventListener("click", () => {
  saveCurrentNote(false);
});

deleteNoteButton.addEventListener("click", deleteCurrentNote);

noteTitle.addEventListener("input", scheduleAutoSave);
noteContent.addEventListener("input", scheduleAutoSave);

// Save drawing changes when the user finishes a stroke.
window.addEventListener("beforeunload", () => {
  clearTimeout(saveTimer);

  if (activeNoteId) {
    saveCurrentNote(true);
  }
});


// ========================================
// 11. CAMERA BUTTON — NEXT PHASE
// ========================================

cameraButton.addEventListener("click", async () => {
  if (cameraRunning) {
    await stopAirWriting();
  } else {
    await startAirWriting();
  }
});


// ========================================
// 12. INITIALIZE THE APPLICATION
// ========================================

function initializeApp() {
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
