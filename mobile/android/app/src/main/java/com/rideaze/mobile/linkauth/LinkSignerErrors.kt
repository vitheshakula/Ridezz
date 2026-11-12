package com.rideaze.mobile.linkauth

/** Every error code the native link signer can report. Messages are only ever these codes. */
enum class LinkSignerError(val code: String) {
  INVALID_ARGUMENT("invalid_argument"),
  IDENTITY_NOT_FOUND("identity_not_found"),
  IDENTITY_LOST("identity_lost"),
  IDENTITY_MISMATCH("identity_mismatch"),
  INVALID_METADATA("invalid_metadata"),
  STATEMENT_REJECTED("statement_rejected"),
  KEYSTORE_UNAVAILABLE("keystore_unavailable"),
  SIGNING_FAILED("signing_failed"),
  INVALID_SIGNATURE_ENCODING("invalid_signature_encoding"),
  BUSY("busy");

  companion object {
    fun from(error: LinkIdentityError): LinkSignerError =
      when (error) {
        LinkIdentityError.INVALID_ARGUMENT -> INVALID_ARGUMENT
        LinkIdentityError.IDENTITY_NOT_FOUND -> IDENTITY_NOT_FOUND
        LinkIdentityError.IDENTITY_LOST -> IDENTITY_LOST
        LinkIdentityError.KEYSTORE_UNAVAILABLE -> KEYSTORE_UNAVAILABLE
        LinkIdentityError.IDENTITY_MISMATCH -> IDENTITY_MISMATCH
        LinkIdentityError.INVALID_METADATA -> INVALID_METADATA
      }
  }
}

/** The message is just the stable code; the original exception is kept as the cause for diagnosis. */
class LinkSignerException(val error: LinkSignerError, cause: Throwable? = null) :
  Exception(error.code, cause)
