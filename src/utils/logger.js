import winston from 'winston';
import fs from 'fs';

// Ensure logs directory exists
const logsDir = 'logs';
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => {
            return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        }),
        new winston.transports.File({
            filename: 'logs/bot.log',
            maxsize: 10 * 1024 * 1024, // 10 MB per file
            maxFiles: 3,               // Keep last 3 rotated files
            tailable: true             // Always write to bot.log, rotate older ones
        })
    ]
});

/**
 * Helper to create profile-scoped logger.
 * Uses Winston's child() so every log entry automatically carries { profileId } as metadata.
 * @param {string} profileId - The unique identifier for the browser profile.
 * @returns {import('winston').Logger} A scoped logger instance.
 */
export const createScopedLogger = (profileId) => {
    return logger.child({ profileId });
};

export default logger;
