const pino = require('pino');
const { LOG_LEVEL = 'info' } = process.env;

const logger = pino({
  level: LOG_LEVEL,
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : {
          target: 'pino-pretty',
          options: {
            colorize: true,
            singleLine: true,
            translateTime: 'SYS:standard'
          }
        }
});

module.exports = logger;
