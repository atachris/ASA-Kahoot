const SHAPES = ['▲', '◆', '●', '■'];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

async function api(name, body) {
  const r = await fetch('/api/' + name, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error || 'Something went wrong.');
    err.status = r.status;
    throw err;
  }
  return data;
}

// Armenian tricolor blobs drifting around the background
(function () {
  const COLORS = ['#d90012', '#0033a0', '#f2a800'];
  const rand = (a, b) => a + Math.random() * (b - a);
  const still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function pos() { return { x: rand(-10, 110), y: rand(-10, 110), s: rand(0.7, 1.6) }; }
  function frame(p) { return { transform: `translate(${p.x}vw, ${p.y}vh) translate(-50%, -50%) scale(${p.s})` }; }

  function drift(blob, from) {
    const to = pos();
    const a = blob.animate([frame(from), frame(to)], { duration: rand(7000, 16000), easing: 'ease-in-out', fill: 'forwards' });
    a.onfinish = () => drift(blob, to);
  }

  function init() {
    const bg = document.createElement('div');
    bg.id = 'bg';
    bg.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 9; i++) {
      const blob = document.createElement('div');
      blob.className = 'blob';
      const size = rand(22, 42);
      blob.style.cssText = `width:${size}vmin;height:${size}vmin;background:${COLORS[i % 3]}`;
      bg.appendChild(blob);
      const start = pos();
      blob.style.transform = frame(start).transform;
      if (!still) drift(blob, start);
    }
    document.body.prepend(bg);
  }

  if (document.body) init(); else document.addEventListener('DOMContentLoaded', init);
})();
