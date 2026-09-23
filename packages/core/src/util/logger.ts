/**
 * Centralized logging utility for VibeFix
 * Provides structured logging with levels and context
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

interface LogEntry {
  level: LogLevel;
  timestamp: string;
  context: string;
  message: string;
  data?: unknown;
}

export class Logger {
  private static instance: Logger;
  private logs: LogEntry[] = [];
  private maxLogs = 1000;
  private minLevel: LogLevel = LogLevel.INFO;

  private constructor() {}

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  private log(level: LogLevel, context: string, message: string, data?: unknown): void {
    if (level < this.minLevel) return;

    const entry: LogEntry = {
      level,
      timestamp: new Date().toISOString(),
      context,
      message,
      data,
    };

    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // Console output with appropriate formatting
    const levelName = LogLevel[level];
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${levelName}] [${context}]`;

    switch (level) {
      case LogLevel.DEBUG:
        console.debug(prefix, message, data ?? '');
        break;
      case LogLevel.INFO:
        console.info(prefix, message, data ?? '');
        break;
      case LogLevel.WARN:
        console.warn(prefix, message, data ?? '');
        break;
      case LogLevel.ERROR:
        console.error(prefix, message, data ?? '');
        break;
    }
  }

  debug(context: string, message: string, data?: unknown): void {
    this.log(LogLevel.DEBUG, context, message, data);
  }

  info(context: string, message: string, data?: unknown): void {
    this.log(LogLevel.INFO, context, message, data);
  }

  warn(context: string, message: string, data?: unknown): void {
    this.log(LogLevel.WARN, context, message, data);
  }

  error(context: string, message: string, data?: unknown): void {
    this.log(LogLevel.ERROR, context, message, data);
  }

  getLogs(context?: string, level?: LogLevel): LogEntry[] {
    let filtered = this.logs;
    if (context) {
      filtered = filtered.filter(log => log.context === context);
    }
    if (level !== undefined) {
      filtered = filtered.filter(log => log.level >= level);
    }
    return filtered;
  }

  clearLogs(): void {
    this.logs = [];
  }

  getRecentLogs(count: number = 50): LogEntry[] {
    return this.logs.slice(-count);
  }
}

// Convenience functions
export const logger = Logger.getInstance();

export const debug = (context: string, message: string, data?: unknown) => logger.debug(context, message, data);
export const info = (context: string, message: string, data?: unknown) => logger.info(context, message, data);
export const warn = (context: string, message: string, data?: unknown) => logger.warn(context, message, data);
export const error = (context: string, message: string, data?: unknown) => logger.error(context, message, data);
