import logger from './logger.js';

/**
 * MemoryWatchdog tracks the process's memory usage and heap statistics.
 * Logs RSS and Heap usage every X minutes to help identify long-term leaks.
 */
class MemoryWatchdog {
    constructor(intervalMinutes = 15) {
        this.interval = intervalMinutes * 60 * 1000;
        this.timer = null;
        this.records = [];
    }

    start() {
        if (this.timer) return;
        
        logger.info(`[Memory] Watchdog started (Interval: ${this.interval / 1000 / 60}m)`);
        this.timer = setInterval(() => this.logStats(), this.interval);
        this.logStats(); // Initial log
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
            logger.info('[Memory] Watchdog stopped');
        }
    }

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
        
        // Check for aggressive growth
        if (parseFloat(heapUsed) > 500) {
            logger.warn(`[Memory] High heap usage detected: ${heapUsed}MB`);
        }
    }

    getHistory() {
        return this.records;
    }
}

export default new MemoryWatchdog();
