import winston from 'winston';

import fs from 'fs';
import path from 'path';

// Ensure logs directory exists
const logsDir = 'logs';
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Generate session-based filename
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const sessionLogFile = path.join(logsDir, `session_${timestamp}.log`);

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
        new winston.transports.File({ filename: 'logs/bot.log' }), // Keep main log
        new winston.transports.File({ filename: sessionLogFile }) // Add session log
    ]
});

// Helper to create profile-scoped logger
// Uses Winston's child() so every log entry auto-carries { profileId } as metadata
export const createScopedLogger = (profileId) => {
    return logger.child({ profileId });
};


export default logger;
