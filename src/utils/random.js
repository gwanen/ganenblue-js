/**
 * Generates a random integer within a specified range.
 * @param {number} [min=500] - Minimum delay in ms.
 * @param {number} [max=1500] - Maximum delay in ms.
 * @returns {number} A random integer between min and max.
 */
export function randomDelay(min = 500, max = 1500) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Pauses execution for a specified duration with optional jitter.
 * @param {number} baseMs - The base sleep duration in ms.
 * @param {number} [jitterPercent=0] - The percentage of jitter to apply (0-100).
 * @returns {Promise<void>}
 */
export async function sleep(baseMs, jitterPercent = 0) {
    const jitter = baseMs * (jitterPercent / 100);
    const actualDelay = baseMs + (Math.random() * jitter * 2 - jitter);
    return new Promise(resolve => setTimeout(resolve, actualDelay));
}

/**
 * Generates a set of points following a Cubic Bezier curve for human-like mouse movement.
 * @param {object} start - Starting coordinates {x, y}.
 * @param {object} end - Ending coordinates {x, y}.
 * @param {number} [steps=0] - Number of points to generate (0 for automatic).
 * @returns {Array<object>} List of point objects.
 */
export function generateBezierCurve(start, end, steps = 0) {
    const distance = Math.sqrt(Math.pow(end.x - start.x, 2) + Math.pow(end.y - start.y, 2));
    const calculatedSteps = steps || Math.max(15, Math.min(40, Math.floor(distance / 20)));

    const points = [];
    const cp1x = start.x + (end.x - start.x) * (0.05 + Math.random() * 0.5);
    const cp1y = start.y + (end.y - start.y) * (0.05 + Math.random() * 0.5);
    const cp2x = start.x + (end.x - start.x) * (0.4 + Math.random() * 0.5);
    const cp2y = start.y + (end.y - start.y) * (0.4 + Math.random() * 0.5);

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

/**
 * Generates a random float within a range.
 * @param {number} min - Lower bound.
 * @param {number} max - Upper bound.
 * @returns {number} Random float.
 */
export function getRandomInRange(min, max) {
    return Math.random() * (max - min) + min;
}

/**
 * Generates a random number following a Normal (Gaussian) distribution.
 * @param {number} mean - The average value.
 * @param {number} sigma - The standard deviation.
 * @returns {number} Distributed random number.
 */
export function getNormalRandom(mean, sigma) {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return z * sigma + mean;
}
