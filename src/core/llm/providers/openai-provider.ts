import { Injectable, Inject } from '@core/di/decorators';
import { Result } from '@core/result/result';
import { BaseLLMProvider } from '@core/llm/llm-provider';
import { LLMProviderError } from '@core/llm/llm-provider-errors';
import { ModelNotFoundError } from '../../errors/model-not-found-error';
import type { ILogger } from '@core/services/logger-service';
import { LLMConfig } from 'types/shared';
import {
  ChatOpenAI,
  type ChatOpenAICallOptions,
  // type ChatOpenAIParameters, // This is not exported directly
} from '@langchain/openai';
import { z } from 'zod';
import { type Runnable } from '@langchain/core/runnables';
import { type BaseLanguageModelInput } from '@langchain/core/language_models/base';

import { retryWithBackoff } from '@core/utils/retry-utils';

// Type alias for ChatOpenAI constructor parameters
type ActualChatOpenAIConstructorParams = ConstructorParameters<typeof ChatOpenAI>[0];

// Locally defined LLMCompletionConfig as it's not found in types/shared
// TODO: This should ideally be moved to a shared types file (e.g., types/shared.d.ts)
interface LLMCompletionConfig {
  temperature?: number;
  maxTokens?: number; // Max tokens for the completion/output
  stopSequences?: string[]; // Will be mapped to 'stop' in runtimeCallOptions
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  // Other parameters from ChatOpenAIParameters can be added here
}
// Removed duplicate LLMCompletionConfig and OpenAICallOptionsSubsetForBind

// Type definitions for OpenAI API responses
type OpenAIModelResponse = {
  data: Array<{
    id: string;
    object: string;
    created: number;
    model: string;
    owned_by: string;
    context_length?: number;
  }>;
};

// OpenAITokenCountResponse type definition fully removed.

@Injectable()
export class OpenAIProvider extends BaseLLMProvider {
  public readonly name = 'openai';
  private model: ChatOpenAI;

  private async makeOpenAIRequest<T>(
    endpoint: string,
    errorContext: string
  ): Promise<Result<T, LLMProviderError>> {
    try {
      const response = await fetch(`https://api.openai.com/v1/${endpoint}`, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const statusCode = response.status;
        const errorCode =
          statusCode === 401
            ? 'AUTHENTICATION_ERROR'
            : statusCode === 429
              ? 'RATE_LIMIT_ERROR'
              : 'API_ERROR';
        const message = `OpenAI API request failed: ${errorContext}`;

        this.logger.warn(`${message} (status ${statusCode})`);
        return Result.err(new LLMProviderError(message, errorCode, this.name, { statusCode }));
      }

      const responseData = await response.json();
      return Result.ok(responseData as T);
    } catch (error) {
      const message = `Failed to ${errorContext}: ${error instanceof Error ? error.message : String(error)}`;
      this.logger.error(message, error instanceof Error ? error : undefined);

      if (error instanceof TypeError && error.message.includes('fetch')) {
        return Result.err(
          new LLMProviderError(
            'Network error connecting to OpenAI API',
            'NETWORK_ERROR',
            this.name,
            {
              cause: error,
            }
          )
        );
      }

      return Result.err(LLMProviderError.fromError(error, this.name));
    }
  }

  async listModels(): Promise<Result<string[], LLMProviderError>> {
    this.logger.debug('Fetching available models from OpenAI API');

    const result = await this.makeOpenAIRequest<OpenAIModelResponse>(
      'models',
      'fetch OpenAI models'
    );
    if (result.isErr()) {
      const error =
        result.error ||
        new LLMProviderError('Unknown error fetching OpenAI models', 'API_ERROR', this.name);
      this.logger.error('Failed to fetch OpenAI models:', error);
      return Result.err(error);
    }

    const data = result.value;
    if (!data?.data || !Array.isArray(data.data)) {
      const message = 'Invalid response format from OpenAI API: missing or invalid data array';
      this.logger.warn(message);
      return Result.err(new LLMProviderError(message, 'INVALID_RESPONSE', this.name));
    }

    const modelIds = data.data.map((model) => model.id);
    if (modelIds.length === 0) {
      const message = 'No models found in OpenAI API response';
      this.logger.warn(message);
      return Result.err(new LLMProviderError(message, 'NO_MODELS_FOUND', this.name));
    }

    this.logger.debug(`Successfully fetched ${modelIds.length} models from OpenAI API`);
    return Result.ok(modelIds);
  }
  // private tiktokenEncoder: Tiktoken | undefined; // Removed, using this.model.getNumTokens()

  constructor(
    private readonly config: LLMConfig,
    @Inject('ILogger') private readonly logger: ILogger
  ) {
    super();
    const constructorParams: ActualChatOpenAIConstructorParams = {
      openAIApiKey: this.config.apiKey,
      modelName: this.config.model,
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
    };
    this.model = new ChatOpenAI(constructorParams);

    const contextSize = this._getDefaultContextSizeForModel(this.config.model);
    this.defaultContextSize = contextSize ?? 4096; // Fallback to 4096 for unknown models
    if (contextSize === undefined) {
      this.logger.warn(
        `OpenAIProvider: Using fallback context size (4096) for unknown model: ${this.config.model}`
      );
    }
  }

  private _getDefaultContextSizeForModel(modelName: string): number | undefined {
    // Based on https://platform.openai.com/docs/models/overview
    if (modelName.includes('gpt-4-turbo')) return 128000;
    if (modelName.includes('gpt-4-32k')) return 32768;
    if (
      modelName.includes('gpt-4') &&
      !modelName.includes('gpt-4-turbo') &&
      !modelName.includes('gpt-4-32k')
    )
      return 8192;
    if (modelName.includes('gpt-3.5-turbo-16k')) return 16385;
    if (modelName.includes('gpt-3.5-turbo-0125')) return 16385;
    if (modelName.includes('gpt-3.5-turbo-1106')) return 16385;
    if (modelName.includes('gpt-3.5-turbo-instruct')) return 4096;
    if (modelName.includes('gpt-3.5-turbo')) return 4096;

    this.logger.warn(`OpenAIProvider: Unknown model name "${modelName}" for context size.`);
    return undefined;
  }

  /**
   * Get the maximum token context window size for a specific OpenAI model
   * @param modelName The name of the OpenAI model
   * @returns Result containing either the context window size or an error
   */
  public getTokenContextWindow(modelName: string): Result<number, LLMProviderError> {
    this.logger.debug(`Getting token context window for OpenAI model: ${modelName}`);

    const contextSize = this._getDefaultContextSizeForModel(modelName);

    if (contextSize === undefined) {
      const error = new ModelNotFoundError(
        `Model '${modelName}' not found in OpenAI context window mapping`,
        this.name
      );
      this.logger.error('Failed to get token context window:', error);
      return Result.err(error);
    }

    this.logger.debug(`Found context window size for ${modelName}: ${contextSize} tokens`);
    return Result.ok(contextSize);
  }

  // _initializeTiktoken method removed

  async getCompletion(
    systemPrompt: string,
    userPrompt: string
  ): Promise<Result<string, LLMProviderError>> {
    try {
      this.logger.debug(`Sending completion request to OpenAI (model: ${this.config.model})`);
      const response = await this.model.predict(`${systemPrompt}\n\nUser Input: ${userPrompt}`);
      return Result.ok(response);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Failed to get completion from OpenAI', err);
      return Result.err(LLMProviderError.fromError(error, this.name));
    }
  }

  async getContextWindowSize(): Promise<number> {
    try {
      // Get model info from OpenAI API
      const response = await fetch(`https://api.openai.com/v1/models/${this.config.model}`, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        this.logger.warn(
          `Failed to get context window size for model ${this.config.model}, using default`
        );
        return Promise.resolve(this.defaultContextSize);
      }

      const data = (await response.json()) as OpenAIModelResponse;
      // Extract context window size from model info
      // Different models have different context sizes
      const contextSize = data?.data?.[0]?.context_length || this.defaultContextSize;
      return Promise.resolve(contextSize);
    } catch (error: any) {
      this.logger.warn(
        `Failed to get context window size for model ${this.config.model}, using default ${error?.message}`
      );
      return Promise.resolve(this.defaultContextSize);
    }
  }

  async countTokens(text: string): Promise<number> {
    try {
      // Use the model's built-in getNumTokens method
      const tokenCount = await this.model.getNumTokens(text);
      return tokenCount;
    } catch (error) {
      this.logger.warn(
        `OpenAIProvider: this.model.getNumTokens() failed for model ${this.config.model}. Error: ${error instanceof Error ? error.message : String(error)}. Falling back to approximation.`
      );
      // Fallback to approximation if getNumTokens fails
      return Promise.resolve(Math.ceil(text.length / 4));
    }
  }

  private async _validateInputTokens(
    prompt: string,
    maxOutputTokensConfig?: number
  ): Promise<Result<void, LLMProviderError>> {
    try {
      const currentInputTokens = await this.countTokens(prompt);

      const contextWindowResult = this.getTokenContextWindow(this.config.model);
      if (contextWindowResult.isErr()) {
        // Create a new LLMProviderError from the one returned by getTokenContextWindow
        const originalError = contextWindowResult.error!; // Assert non-null
        const newError = new LLMProviderError(
          originalError.message,
          originalError.code,
          originalError.provider,
          { cause: originalError.cause }
        );
        return Result.err(newError);
      }
      const modelContextWindow = contextWindowResult.value!;

      const maxOutputTokens = maxOutputTokensConfig ?? this.config.maxTokens ?? 2048;
      const availableForInput = modelContextWindow - maxOutputTokens;

      this.logger.debug(
        `OpenAIProvider: Input tokens: ${currentInputTokens}, Available for input: ${availableForInput} (Model Context: ${modelContextWindow}, Reserved for Output: ${maxOutputTokens}) for model ${this.config.model}`
      );

      if (currentInputTokens > availableForInput) {
        const errorMsg = `Input prompt (${currentInputTokens} tokens) for OpenAI structured completion exceeds model's available input token limit (${availableForInput} tokens). Model: ${this.config.model}, Total Context: ${modelContextWindow}, Reserved for Output: ${maxOutputTokens}.`;
        this.logger.warn(errorMsg);
        return Result.err(new LLMProviderError(errorMsg, 'VALIDATION_ERROR', this.name));
      }
      return Result.ok(undefined);
    } catch (validationError: unknown) {
      const message = `Error during pre-call token validation in OpenAIProvider: ${validationError instanceof Error ? validationError.message : String(validationError)}`;
      const errorToLog = validationError instanceof Error ? validationError : new Error(message);
      this.logger.error(message, errorToLog);
      return Result.err(
        new LLMProviderError(message, 'UNKNOWN_ERROR', this.name, {
          cause: errorToLog,
        })
      );
    }
  }

  public async getStructuredCompletion<T extends z.ZodTypeAny>(
    prompt: BaseLanguageModelInput,
    schema: T,
    completionConfig?: LLMCompletionConfig // Ensure optional by '?'
  ): Promise<Result<z.infer<T>, LLMProviderError>> {
    this.logger.debug(
      `OpenAIProvider: Getting structured completion for model ${this.config.model}. Prompt type: ${typeof prompt === 'string' ? 'string' : 'BaseLanguageModelInput Object'}`
    ); // Combined into one string

    const promptAsStringForValidation =
      typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
    const maxOutputTokensForThisCall = completionConfig?.maxTokens ?? this.config.maxTokens;

    const tokenValidationResult = await this._validateInputTokens(
      promptAsStringForValidation,
      maxOutputTokensForThisCall
    );
    if (tokenValidationResult.isErr()) {
      // Assuming tokenValidationResult.error is always LLMProviderError when isErr() is true
      return Result.err<LLMProviderError>(tokenValidationResult.error!);
    }

    // Start with the base model, then apply .bind() for per-call parameters
    let runnableToInvoke: Runnable<
      BaseLanguageModelInput,
      z.infer<T>
    > = this.model.withStructuredOutput(schema, {
      name: schema.description || `extract_${schema.constructor?.name || 'data'}`,
    });

    const bindOptions: Partial<ActualChatOpenAIConstructorParams> = {};
    const runtimeCallOptions: Partial<ChatOpenAICallOptions> = {};

    if (completionConfig) {
      if (completionConfig.temperature !== undefined)
        bindOptions.temperature = completionConfig.temperature;
      if (completionConfig.maxTokens !== undefined)
        bindOptions.maxTokens = completionConfig.maxTokens;
      if (completionConfig.topP !== undefined) bindOptions.topP = completionConfig.topP;
      if (completionConfig.presencePenalty !== undefined)
        bindOptions.presencePenalty = completionConfig.presencePenalty;
      if (completionConfig.frequencyPenalty !== undefined)
        bindOptions.frequencyPenalty = completionConfig.frequencyPenalty;

      if (completionConfig.stopSequences && completionConfig.stopSequences.length > 0) {
        runtimeCallOptions.stop = completionConfig.stopSequences;
      }
    }

    if (Object.keys(bindOptions).length > 0) {
      runnableToInvoke = runnableToInvoke.bind(bindOptions);
      // Assuming logger.debug takes a single string. If it takes (message, meta), this was:
      // this.logger.debug(`OpenAIProvider: Bound temporary configurations for this call`, { bindOptions });
      this.logger.debug(
        `OpenAIProvider: Bound temporary configurations for this call. Options: ${JSON.stringify(bindOptions)}`
      );
    }

    try {
      const parsedObject = await this._performStructuredCallWithRetry(
        runnableToInvoke,
        prompt,
        runtimeCallOptions
      );

      this.logger.debug(
        `OpenAIProvider: Successfully received structured response for model ${this.config.model}`
        // { response: parsedObject } // Consider logging only if small/non-sensitive
      );
      return Result.ok(parsedObject);
    } catch (error: unknown) {
      const errorToLog = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `OpenAIProvider: Error in getStructuredCompletion for model ${this.config.model}`,
        errorToLog // Pass error instance directly
      );

      if (error instanceof LLMProviderError) {
        return Result.err(error);
      }

      let errorCode = 'API_ERROR';
      let message = `OpenAI API error: ${error instanceof Error ? error.message : String(error)}`;
      const cause = error instanceof Error ? error : new Error(String(error)); // Ensure cause is Error
      let statusCode: number | undefined;
      const anyError = error as any;

      if (anyError.status && typeof anyError.status === 'number') {
        statusCode = anyError.status;
      } else if (anyError.response?.status && typeof anyError.response.status === 'number') {
        statusCode = anyError.response.status;
      }

      if (anyError.response?.data?.error) {
        const oaiError = anyError.response.data.error;
        message = `OpenAI API Error: ${oaiError.message} (Type: ${oaiError.type || 'N/A'}, Code: ${oaiError.code || 'N/A'})`;
        if (oaiError.type === 'invalid_request_error') errorCode = 'VALIDATION_ERROR';
        else if (oaiError.type === 'insufficient_quota') errorCode = 'RATE_LIMIT_ERROR';
        else if (oaiError.type === 'api_error') errorCode = 'API_ERROR';
        if (oaiError.code === 'context_length_exceeded') errorCode = 'VALIDATION_ERROR';
      } else if (anyError.message?.toLowerCase().includes('context_length_exceeded')) {
        errorCode = 'VALIDATION_ERROR';
        message = anyError.message;
      }

      if (statusCode) {
        if (statusCode === 401) errorCode = 'AUTHENTICATION_ERROR';
        else if (statusCode === 429) errorCode = 'RATE_LIMIT_ERROR';
        else if (statusCode === 400 && errorCode === 'UNKNOWN_ERROR')
          errorCode = 'VALIDATION_ERROR';
        else if (statusCode >= 500 && errorCode === 'UNKNOWN_ERROR') errorCode = 'API_ERROR';
      }

      return Result.err(new LLMProviderError(message, errorCode, this.name, { cause, statusCode }));
    }
  }

  private async _performStructuredCallWithRetry<TOutput>(
    structuredModel: Runnable<BaseLanguageModelInput, TOutput>,
    prompt: BaseLanguageModelInput,
    callOptions?: Partial<ChatOpenAICallOptions>
  ): Promise<TOutput> {
    // TODO: Make retry options configurable via LLMConfig if they are added there.
    const retryAttempts = (this.config as any).retryAttempts ?? 3;
    const initialDelay = (this.config as any).retryInitialDelayMs ?? 1000;
    const maxDelay = (this.config as any).retryMaxDelayMs ?? 30000;
    const factor = (this.config as any).retryFactor ?? 2;

    const RETRY_OPTIONS = {
      retries: retryAttempts,
      initialDelay: initialDelay,
      maxDelay: maxDelay,
      factor: factor,
      shouldRetry: (error: any): boolean => {
        const status = error?.status ?? error?.response?.status;
        if (
          status === 429 ||
          status === 500 ||
          status === 502 ||
          status === 503 ||
          status === 504
        ) {
          this.logger.warn(
            `OpenAIProvider: Retriable API error (status ${status}) for model ${this.config.model}. Retrying... Error: ${error.message}`
          ); // Combined into one string
          return true;
        }
        const oaiErrorData = error?.response?.data?.error || error?.error;
        const oaiErrorCode = oaiErrorData?.code;
        if (oaiErrorCode === 'rate_limit_exceeded' || oaiErrorCode === 'insufficient_quota') {
          this.logger.warn(
            `OpenAIProvider: Retriable API error (code ${oaiErrorCode}) for model ${this.config.model}. Retrying... Error: ${oaiErrorData?.message || error.message}`
          ); // Combined into one string
          return true;
        }
        return false;
      },
    };

    return retryWithBackoff(async () => {
      try {
        const response = await structuredModel.invoke(prompt, callOptions);
        return response;
      } catch (error: any) {
        // Ensure this logger.warn call uses a single string argument
        const meta = {
          errorMessage: error.message,
          errorName: error.name,
          errorStatus: error.status,
          errorCode: error.code, // Note: 'code' might not exist on all error objects
          errorResponseData: error.response?.data,
        };
        this.logger.warn(
          `OpenAIProvider: API call attempt failed for model ${this.config.model}. Details: ${JSON.stringify(meta)}`
        );
        throw error;
      }
    }, RETRY_OPTIONS);
  }
}
