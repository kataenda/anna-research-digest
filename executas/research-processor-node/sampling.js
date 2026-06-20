/**
 * SamplingClient — issue reverse `sampling/createMessage` JSON-RPC requests
 * to the host Agent (Anna). Vendored (ESM) from the Anna Executa Node SDK
 * (sdk/nodejs/sampling.js in whtcjdtc2007/anna-executa-examples).
 *
 * Why reverse RPC? Plugins do NOT need their own LLM API key — billing,
 * quotas and model routing are owned by the host (Anna). Wire it up by
 * feeding every non-method JSON-RPC frame from stdin to dispatchResponse().
 */

import crypto from "node:crypto";

export const PROTOCOL_VERSION_V1 = "1.1";
export const PROTOCOL_VERSION_V2 = "2.0";

export const METHOD_INITIALIZE = "initialize";
export const METHOD_SHUTDOWN = "shutdown";
export const METHOD_SAMPLING_CREATE_MESSAGE = "sampling/createMessage";

export const SAMPLING_ERR_NOT_GRANTED = -32001;
export const SAMPLING_ERR_QUOTA_EXCEEDED = -32002;
export const SAMPLING_ERR_PROVIDER_ERROR = -32003;
export const SAMPLING_ERR_INVALID_REQUEST = -32004;
export const SAMPLING_ERR_TIMEOUT = -32005;
export const SAMPLING_ERR_MAX_CALLS_EXCEEDED = -32006;
export const SAMPLING_ERR_MAX_TOKENS_EXCEEDED = -32007;
export const SAMPLING_ERR_NOT_NEGOTIATED = -32008;
export const SAMPLING_ERR_USER_DENIED = -32009;
export const SAMPLING_ERR_UNSUPPORTED_RESPONSE_FORMAT = -32010;

export class SamplingError extends Error {
  constructor(code, message, data) {
    super(`[${code}] ${message}`);
    this.name = "SamplingError";
    this.code = code;
    this.data = data || {};
  }
}

export class SamplingClient {
  constructor(opts = {}) {
    this._writeFrame =
      opts.writeFrame ||
      ((msg) => {
        process.stdout.write(JSON.stringify(msg) + "\n");
      });
    this._pending = new Map();
    this._disabledReason = null;
  }

  disable(reason) {
    this._disabledReason = reason;
  }

  createMessage(params) {
    if (this._disabledReason) {
      return Promise.reject(
        new SamplingError(SAMPLING_ERR_NOT_NEGOTIATED, this._disabledReason)
      );
    }
    const {
      messages,
      maxTokens,
      systemPrompt,
      temperature,
      stopSequences,
      modelPreferences,
      includeContext = "none",
      metadata,
      responseFormat,
      onUnsupported,
      timeoutMs = 90_000,
    } = params || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return Promise.reject(new TypeError("messages must be a non-empty array"));
    }
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      return Promise.reject(new TypeError("maxTokens must be a positive integer"));
    }

    const reqId = crypto.randomUUID();
    const rpcParams = { messages, maxTokens, includeContext };
    if (systemPrompt != null) rpcParams.systemPrompt = systemPrompt;
    if (temperature != null) rpcParams.temperature = temperature;
    if (stopSequences) rpcParams.stopSequences = stopSequences;
    if (modelPreferences) rpcParams.modelPreferences = modelPreferences;
    if (metadata) rpcParams.metadata = metadata;
    if (responseFormat != null) rpcParams.responseFormat = responseFormat;
    if (onUnsupported != null) rpcParams.onUnsupported = onUnsupported;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.delete(reqId)) {
          reject(
            new SamplingError(
              SAMPLING_ERR_TIMEOUT,
              `sampling/createMessage timed out after ${timeoutMs}ms`
            )
          );
        }
      }, timeoutMs);
      this._pending.set(reqId, { resolve, reject, timer });

      try {
        this._writeFrame({
          jsonrpc: "2.0",
          id: reqId,
          method: METHOD_SAMPLING_CREATE_MESSAGE,
          params: rpcParams,
        });
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(reqId);
        reject(err);
      }
    });
  }

  dispatchResponse(msg) {
    if (!msg || typeof msg !== "object" || "method" in msg) return false;
    const id = msg.id;
    if (id == null) return false;
    const pending = this._pending.get(id);
    if (!pending) return false;
    this._pending.delete(id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(
        new SamplingError(
          Number(msg.error.code) || -32603,
          String(msg.error.message || "unknown error"),
          msg.error.data
        )
      );
    } else {
      pending.resolve(msg.result || {});
    }
    return true;
  }
}
