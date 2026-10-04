const logger = require('../utils/logger');

function errorHandler(err, req, res, next) {
  logger.error('Unhandled Gateway Exception', {
    requestId: req.id,
    url: req.originalUrl,
    method: req.method,
    error: err.message,
    stack: err.stack
  });

  res.locals.errorMessage = err.message;

  if (res.headersSent) {
    return next(err);
  }

  const statusCode = err.status || err.statusCode || 500;
  return res.status(statusCode).json({
    error: statusCode === 500 ? 'Internal Server Error' : err.name || 'Error',
    message: err.message || 'An unexpected error occurred within the API gateway.',
    requestId: req.id
  });
}

module.exports = errorHandler;
