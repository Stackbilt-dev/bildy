export class GatewayError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, code = "gateway_error", statusCode = 500) {
    super(message);
    this.name = "GatewayError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class AuthError extends GatewayError {
  constructor(message = "Unauthorized") {
    super(message, "auth_error", 401);
    this.name = "AuthError";
  }
}

export class ValidationError extends GatewayError {
  constructor(message: string) {
    super(message, "validation_error", 400);
    this.name = "ValidationError";
  }
}
