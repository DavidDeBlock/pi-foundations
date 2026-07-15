/* ============================================================
   a4-math — problem generator + renderer
   ============================================================ */

const $ = (sel) => document.querySelector(sel);
const worksheets = $("#worksheets");
const form = $("#config");
const printBtn = $("#print");
const resetBtn = $("#reset");
const borrowingRow = $("#borrowing-row");
const pageCount = $("#page-count");

const DEFAULTS = {
  operation: "addition",
  min: 1,
  max: 20,
  count: 30,
  borrowing: false,
  answers: false,
  title: "Math Practice",
};

// Layout lookup: count → [cols, rows]
const LAYOUT = {
  20: [4, 5],
  30: [3, 10],
  40: [4, 10],
};

// Show/hide "Allow borrowing" based on operation
function syncBorrowingVisibility() {
  const op = form.operation.value;
  borrowingRow.style.display = op === "subtraction" ? "" : "none";
}

form.addEventListener("change", (event) => {
  if (event.target.name === "operation") syncBorrowingVisibility();
});

// ------------------------------------------------------------
// Problem generation
// ------------------------------------------------------------

const randInt = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

// Returns true if a-b requires borrowing in any digit column.
const needsBorrow = (a, b) => {
  while (b > 0) {
    if ((a % 10) < (b % 10)) return true;
    a = Math.floor(a / 10);
    b = Math.floor(b / 10);
  }
  return false;
};

function makeProblem(op, min, max, allowBorrowing) {
  if (op === "+") {
    const a = randInt(min, max);
    const b = randInt(min, max);
    return { a, b, op: "+", answer: a + b };
  }

  // subtraction
  for (let i = 0; i < 1000; i++) {
    const a = randInt(min, max);
    const b = randInt(min, max);
    if (a >= b && (allowBorrowing || !needsBorrow(a, b))) {
      return { a, b, op: "−", answer: a - b };
    }
  }
  // Fallback (shouldn't happen unless range is impossibly tight)
  return { a: min, b: min, op: "−", answer: 0 };
}

function generate(config) {
  const { operation, min, max, count } = config;
  const allowBorrowing = operation === "subtraction" && config.borrowing;

  const problems = [];
  const seen = new Set();

  for (let i = 0; i < count; i++) {
    let problem;
    let attempts = 0;
    while (attempts < 100) {
      const op = operation === "mixed" ? (Math.random() < 0.5 ? "+" : "−") : operation === "addition" ? "+" : "−";
      problem = makeProblem(op, min, max, allowBorrowing);
      
      const key = problem.op === "+"
        ? `+:${Math.min(problem.a, problem.b)}:${Math.max(problem.a, problem.b)}`
        : `${problem.op}:${problem.a}:${problem.b}`;
        
      if (!seen.has(key)) {
        seen.add(key);
        break;
      }
      attempts++;
    }
    problems.push(problem);
  }
  return problems;
}

// ------------------------------------------------------------
// Rendering
// ------------------------------------------------------------

// Right-align a/b/op so digits line up neatly.
function formatProblem({ a, b, op }) {
  const aStr = String(a);
  const bStr = String(b);
  // Width must accommodate aStr and "X " + bStr
  const width = Math.max(aStr.length, bStr.length + 2); // 2 = operator char + space
  const paddedA = aStr.padStart(width, " ");
  const paddedB = (op + " " + bStr.padStart(width - 2, " "));
  return { paddedA, paddedB };
}

function problemHTML(p, { showAnswer } = {}) {
  const { paddedA, paddedB } = formatProblem(p);
  const answerClass = showAnswer ? "answer" : "answer empty";
  const answerContent = showAnswer ? String(p.answer) : "&nbsp;";
  return `
    <div class="problem">
      <div>${paddedA}</div>
      <div class="op">${paddedB}</div>
      <div class="line"></div>
      <div class="${answerClass}">${answerContent}</div>
    </div>
  `;
}

function pageHeaderHTML(title, kind) {
  return `
    <div class="page-header">
      <div class="title">${escapeHTML(title)}${kind === "key" ? " — Answer Key" : ""}</div>
      <div class="meta">
        <label>Name: <span class="line"></span></label>
        <label>Date: <span class="line"></span></label>
        <label>Score: <span class="line"></span></label>
      </div>
    </div>
  `;
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function pageHTML(problems, { title, kind, cols, rows }) {
  const cells = problems.map((p) => problemHTML(p, { showAnswer: kind === "key" })).join("");
  const colClass = cols === 4 ? "cols-4" : "cols-3";
  const rowClass = rows === 4 ? "rows-4" : rows === 5 ? "rows-5" : "rows-10";
  return `
    <section class="page ${kind === "key" ? "key" : ""}">
      ${pageHeaderHTML(title, kind)}
      <div class="problems ${colClass} ${rowClass}">${cells}</div>
    </section>
  `;
}

// ------------------------------------------------------------
// Main flow
// ------------------------------------------------------------

function readConfig() {
  const fd = new FormData(form);
  const min = Number(fd.get("min"));
  const max = Number(fd.get("max"));
  const count = Number(fd.get("count"));
  const safeMin = Number.isFinite(min) && min >= 0 ? min : DEFAULTS.min;
  const safeMax = Number.isFinite(max) && max > safeMin ? max : DEFAULTS.max;
  const safeCount = LAYOUT[count] ? count : DEFAULTS.count;
  return {
    operation: fd.get("operation") || DEFAULTS.operation,
    min: safeMin,
    max: safeMax,
    count: safeCount,
    borrowing: fd.get("borrowing") === "on",
    answers: fd.get("answers") === "on",
    title: (fd.get("title") || DEFAULTS.title).trim() || DEFAULTS.title,
  };
}

function render(config) {
  const problems = generate(config);
  const [cols, rows] = LAYOUT[config.count];

  let html = pageHTML(problems, { title: config.title, kind: "worksheet", cols, rows });
  if (config.answers) {
    html += pageHTML(problems, { title: config.title, kind: "key", cols, rows });
  }
  worksheets.innerHTML = html;
  pageCount.textContent = config.answers ? "2 pages" : "1 page";
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  render(readConfig());
});

printBtn.addEventListener("click", () => {
  if (!worksheets.querySelector(".page")) {
    render(readConfig());
  }
  window.print();
});

resetBtn.addEventListener("click", () => {
  form.reset();
  syncBorrowingVisibility();
  render(readConfig());
});

// Initial render so the page isn't empty
syncBorrowingVisibility();
render(readConfig());