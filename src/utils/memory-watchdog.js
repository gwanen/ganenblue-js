import logger from './logger.js';

/**
 * Tracks the process's memory usage and heap statistics.
 * Logs RSS and Heap usage periodically to help identify long-term memory leaks.
 */
class MemoryWatchdog {
    /**
     * @param {number} [intervalMinutes=15] - Frequency of memory checks in minutes.
     */
    constructor(intervalMinutes = 15) {
        this.interval = intervalMinutes * 60 * 1000;
        this.timer = null;
        this.records = [];
    }

    /**
     * Starts the memory watchdog timer.
     */
    start() {
        if (this.timer) return;
        
        logger.info(`[Memory] Watchdog started (Interval: ${this.interval / 1000 / 60}m)`);
        this.timer = setInterval(() => this.logStats(), this.interval);
        this.logStats(); // Initial log
    }

    /**
     * Stops the memory watchdog timer.
     */
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            logger.info('[Memory] Watchdog stopped');
        }
    }

    /**
     * Captures and logs current memory statistics.
     * Triggers a warning if heap usage exceeds a critical threshold.
     * @private
     */
    logStats() {
        const memoryUsage = process.memoryUsage();
        const rss = (memoryUsage.rss / 1024 / 1024).toFixed(2);
        const heapTotal = (memoryUsage.heapTotal / 1024 / 1024).toFixed(2);
        const heapUsed = (memoryUsage.heapUsed / 1024 / 1024).toFixed(2);
        const external = (memoryUsage.external / 1024 / 1024).toFixed(2);

        const stats = {
            timestamp: new Date().toISOString(),
            rss: `${rss} MB`,
            heapTotal: `${heapTotal} MB`,
            heapUsed: `${heapUsed} MB`,
            external: `${external} MB`
        };

        this.records.push(stats);
        if (this.records.length > 100) this.records.shift();

        logger.info(`[Memory] Usage: RSS ${rss}MB | Heap ${heapUsed}/${heapTotal}MB | Ext ${external}MB`);
        
        if (parseFloat(heapUsed) > 500) {
            logger.warn(`[Memory] High heap usage detected: ${heapUsed}MB`);
        }
    }

    /**
     * Returns the accumulated history of memory snapshots.
     * @returns {Array<object>} List of memory statistic objects.
     */
    getHistory() {
        return this.records;
    }
}

export default new MemoryWatchdog();
