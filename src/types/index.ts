/**
 * Type definitions and exports
 */

// Export specific error types and utilities
export {
  ErrorFactory,
  isAPIError,
  toAPIErrorResponse,
  formatErrorForLogging,
  isAuthenticationError,
  isStreamingError,
  isValidationError,
  isNetworkError,
  isConfigurationError
} from "./errors.js"

// Export specific HTTP types and utilities
export {
  isHTTPMethod,
  isSuccessStatus,
  isClientError,
  isRedirect,
  parseContentType,
  buildQueryString,
  parseUserAgent
} from "./http.js"

// Re-export commonly used types for convenience
export type {
  AuthenticationError,
  StreamingError,
  ValidationError,
  NetworkError,
  ConfigurationError,
  ServerError,
  APIErrorType,
  APIErrorResponse
} from "./errors.js"

export type {
  HTTPMethod,
  HTTPStatusCode
} from "./http.js"
