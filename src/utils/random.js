/**
 * Human-like randomization utilities
 */

// Random delay between min and max (ms)
export function randomDelay(min = 500, max = 1500) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Sleep with random jitter
export async function sleep(baseMs, jitterPercent = 20) {
  const jitter = baseMs * (jitterPercent / 100);
  const actualDelay = baseMs + (Math.random() * jitter * 2 - jitter);
  return new Promise(resolve => setTimeout(resolve, actualDelay));
}

// Human-like mouse movement
export function generateBezierCurve(start, end, steps = 0) {
  // Dynamic steps based on distance (min 15, max 40)
  const distance = Math.sqrt(Math.pow(end.x - start.x, 2) + Math.pow(end.y - start.y, 2));
  const calculatedSteps = steps || Math.max(15, Math.min(40, Math.floor(distance / 20)));

  const points = [];
  // Randomized control points for natural "arc"
  const cp1x = start.x + (end.x - start.x) * (0.1 + Math.random() * 0.4);
  const cp1y = start.y + (end.y - start.y) * (0.1 + Math.random() * 0.4);
  const cp2x = start.x + (end.x - start.x) * (0.5 + Math.random() * 0.4);
  const cp2y = start.y + (end.y - start.y) * (0.5 + Math.random() * 0.4);

  for (let i = 0; i <= calculatedSteps; i++) {
    const t = i / calculatedSteps;
    const x = Math.pow(1 - t, 3) * start.x +
      3 * Math.pow(1 - t, 2) * t * cp1x +
      3 * (1 - t) * Math.pow(t, 2) * cp2x +
      Math.pow(t, 3) * end.x;
    const y = Math.pow(1 - t, 3) * start.y +
      3 * Math.pow(1 - t, 2) * t * cp1y +
      3 * (1 - t) * Math.pow(t, 2) * cp2y +
      Math.pow(t, 3) * end.y;
    points.push({ x: Math.round(x), y: Math.round(y) });
  }
  return points;
}

// Random typing delay
export async function typeHuman(page, selector, text) {
  await page.focus(selector);
  for (const char of text) {
    await page.keyboard.type(char);
    await sleep(randomDelay(50, 150));
  }
}
// Random number within range
export function getRandomInRange(min, max) {
  return Math.random() * (max - min) + min;
}
// Normal (Gaussian) distribution around a mean with standard deviation
export function getNormalRandom(mean, sigma) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return z * sigma + mean;
}
