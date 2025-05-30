/* eslint-disable @typescript-eslint/unbound-method */
import 'reflect-metadata'; // Required for TypeDI
import { ApplicationContainer } from '../../../src/core/application/application-container';
import {
  ICliInterface,
  IGeneratorOrchestrator,
  IProjectManager,
} from '../../../src/core/application/interfaces';
import { ILLMConfigService } from '../../../src/core/config/interfaces';
import { Result } from '../../../src/core/result/result';
import { ILogger } from '../../../src/core/services/logger-service'; // Keep type import
import { createMockLogger } from '../../__mocks__/logger.mock'; // Import mock factory
import { ProgressIndicator } from '../../../src/core/ui/progress-indicator';
import { LLMConfig } from '../../../types/shared';

// Mocks
const mockGeneratorOrchestrator: jest.Mocked<IGeneratorOrchestrator> = {
  initialize: jest.fn(),
  execute: jest.fn(),
  executeGenerators: jest.fn(), // Added missing method
};

const mockProjectManager: jest.Mocked<IProjectManager> = {
  loadProjectConfig: jest.fn(),
  saveProjectConfig: jest.fn(), // Corrected method name
};

const mockCliInterface: jest.Mocked<ICliInterface> = {
  parseArgs: jest.fn(),
  getParsedArgs: jest.fn(),
  output: jest.fn(), // Added missing method
  prompt: jest.fn(), // Added missing method
};

let mockLogger: jest.Mocked<ILogger>; // Change to let

// Use the actual ProgressIndicator mock from tests/__mocks__
jest.mock('../../../src/core/ui/progress-indicator');
const MockProgressIndicator = ProgressIndicator as jest.MockedClass<typeof ProgressIndicator>;
const mockProgressIndicatorInstance = new MockProgressIndicator() as jest.Mocked<ProgressIndicator>;

const mockLlmConfigService: jest.Mocked<ILLMConfigService> = {
  loadConfig: jest.fn(),
  saveConfig: jest.fn(),
  validateConfig: jest.fn(),
  interactiveEditConfig: jest.fn(),
};

describe('ApplicationContainer', () => {
  let container: ApplicationContainer;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = createMockLogger(); // Initialize mock logger here
    // Reset mock implementations if needed, e.g., mockProgressIndicatorInstance.start.mockClear(); etc.
    mockProgressIndicatorInstance.start.mockClear();
    mockProgressIndicatorInstance.succeed.mockClear();
    mockProgressIndicatorInstance.fail.mockClear();
    mockProgressIndicatorInstance.stop.mockClear();

    container = new ApplicationContainer(
      mockGeneratorOrchestrator,
      mockProjectManager,
      mockCliInterface,
      mockLogger,
      mockProgressIndicatorInstance,
      mockLlmConfigService
    );
  });

  // --- executeConfigCommand ---
  describe('executeConfigCommand', () => {
    const baseConfig: LLMConfig = {
      provider: '',
      apiKey: '',
      model: '',
      maxTokens: 80000,
      temperature: 0.1,
    };

    // --- CLI Options Path ---
    describe('with CLI options', () => {
      const cliOptions = {
        provider: 'cli-provider',
        apiKey: 'cli-key',
        model: 'cli-model',
      };
      const expectedCliConfig: LLMConfig = {
        ...baseConfig, // Defaults for maxTokens/temp are kept
        ...cliOptions,
      };

      it('should update config successfully via CLI options', async () => {
        mockLlmConfigService.validateConfig.mockReturnValue(null); // Validation passes
        mockLlmConfigService.saveConfig.mockResolvedValue(Result.ok(undefined)); // Save succeeds

        // Need to access private method via 'any' for testing
        const result = await (container as any).executeConfigCommand(cliOptions);

        expect(result.isOk()).toBe(true);
        expect(mockProgressIndicatorInstance.start).toHaveBeenCalledWith(
          'Updating configuration with CLI options...'
        );
        expect(mockLlmConfigService.validateConfig).toHaveBeenCalledWith(expectedCliConfig);
        expect(mockLlmConfigService.saveConfig).toHaveBeenCalledWith(expectedCliConfig);
        expect(mockProgressIndicatorInstance.succeed).toHaveBeenCalledWith(
          'LLM configuration updated successfully via CLI flags.'
        );
        expect(mockLogger.info).toHaveBeenCalledWith(
          'LLM configuration updated successfully via CLI flags.'
        );
        expect(mockLogger.error).not.toHaveBeenCalled();
        expect(mockProgressIndicatorInstance.fail).not.toHaveBeenCalled();
        // Ensure stop is called within handleCliConfigUpdate's finally block
        expect(mockProgressIndicatorInstance.stop).toHaveBeenCalledTimes(1);
      });

      it('should return error if CLI validation fails', async () => {
        const validationErrorMsg = 'Invalid provider';
        mockLlmConfigService.validateConfig.mockReturnValue(validationErrorMsg);

        const result = await (container as any).executeConfigCommand(cliOptions);

        expect(result.isErr()).toBe(true);
        expect(result.error?.message).toContain(
          `Invalid LLM configuration via CLI options: ${validationErrorMsg}`
        );
        expect(mockProgressIndicatorInstance.start).toHaveBeenCalledWith(
          'Updating configuration with CLI options...'
        );
        expect(mockLlmConfigService.validateConfig).toHaveBeenCalledWith(expectedCliConfig);
        expect(mockLlmConfigService.saveConfig).not.toHaveBeenCalled();
        expect(mockProgressIndicatorInstance.fail).toHaveBeenCalledWith(
          `Invalid LLM configuration via CLI options: ${validationErrorMsg}`
        );
        expect(mockLogger.error).toHaveBeenCalledWith(
          `Invalid LLM configuration via CLI options: ${validationErrorMsg}`
        );
        expect(mockProgressIndicatorInstance.succeed).not.toHaveBeenCalled();
        expect(mockProgressIndicatorInstance.stop).toHaveBeenCalledTimes(1); // Called in finally
      });

      it('should return error if CLI save fails', async () => {
        const saveError = new Error('Disk full');
        mockLlmConfigService.validateConfig.mockReturnValue(null); // Validation passes
        mockLlmConfigService.saveConfig.mockResolvedValue(Result.err(saveError)); // Save fails

        const result = await (container as any).executeConfigCommand(cliOptions);

        expect(result.isErr()).toBe(true);
        expect(result.error).toBe(saveError);
        expect(mockProgressIndicatorInstance.start).toHaveBeenCalledWith(
          'Updating configuration with CLI options...'
        );
        expect(mockLlmConfigService.validateConfig).toHaveBeenCalledWith(expectedCliConfig);
        expect(mockLlmConfigService.saveConfig).toHaveBeenCalledWith(expectedCliConfig);
        expect(mockProgressIndicatorInstance.fail).toHaveBeenCalledWith(
          `CLI config save failed: ${saveError.message}`
        );
        expect(mockLogger.error).toHaveBeenCalledWith(
          `CLI config save failed: ${saveError.message}`
        );
        expect(mockProgressIndicatorInstance.succeed).not.toHaveBeenCalled();
        expect(mockProgressIndicatorInstance.stop).toHaveBeenCalledTimes(1); // Called in finally
      });

      it('should handle unexpected errors during CLI update', async () => {
        const unexpectedError = new Error('Unexpected boom');
        mockLlmConfigService.validateConfig.mockImplementation(() => {
          throw unexpectedError; // Simulate error during validation call
        });

        const result = await (container as any).executeConfigCommand(cliOptions);

        expect(result.isErr()).toBe(true);
        expect(result.error?.message).toContain(
          `CLI config update failed: ${unexpectedError.message}`
        );
        expect(mockProgressIndicatorInstance.start).toHaveBeenCalledWith(
          'Updating configuration with CLI options...'
        );
        expect(mockLlmConfigService.saveConfig).not.toHaveBeenCalled();
        expect(mockProgressIndicatorInstance.fail).toHaveBeenCalledWith(
          `CLI config update failed unexpectedly: ${unexpectedError.message}`
        );
        expect(mockLogger.error).toHaveBeenCalledWith(
          `CLI config update failed unexpectedly: ${unexpectedError.message}`,
          unexpectedError
        );
        expect(mockProgressIndicatorInstance.succeed).not.toHaveBeenCalled();
        expect(mockProgressIndicatorInstance.stop).toHaveBeenCalledTimes(1); // Called in finally
      });
    });

    // --- Interactive Path ---
    describe('with interactive mode', () => {
      const interactiveOptions = {}; // No relevant CLI flags

      it('should update config successfully via interactive mode', async () => {
        mockLlmConfigService.interactiveEditConfig.mockResolvedValue(Result.ok(undefined));

        const result = await (container as any).executeConfigCommand(interactiveOptions);

        expect(result.isOk()).toBe(true);
        expect(mockProgressIndicatorInstance.start).toHaveBeenCalledWith(
          'Starting interactive configuration...'
        );
        expect(mockLlmConfigService.interactiveEditConfig).toHaveBeenCalledWith(baseConfig);
        // Success message/progress handled within interactiveEditConfig mock (or assumed)
        // expect(mockProgressIndicatorInstance.succeed).toHaveBeenCalledWith('Configuration updated successfully via interactive mode.'); // This is now handled inside the service potentially
        expect(mockLogger.info).toHaveBeenCalledWith(
          'Configuration updated successfully via interactive mode.'
        );
        expect(mockLogger.error).not.toHaveBeenCalled();
        expect(mockProgressIndicatorInstance.fail).not.toHaveBeenCalled();
        // expect(mockProgressIndicatorInstance.stop).toHaveBeenCalledTimes(1); // Stop is handled within service now
      });

      it('should return error if interactive edit fails', async () => {
        const interactiveError = new Error('User cancelled');
        mockLlmConfigService.interactiveEditConfig.mockResolvedValue(Result.err(interactiveError));

        const result = await (container as any).executeConfigCommand(interactiveOptions);

        expect(result.isErr()).toBe(true);
        expect(result.error).toBe(interactiveError);
        expect(mockProgressIndicatorInstance.start).toHaveBeenCalledWith(
          'Starting interactive configuration...'
        );
        expect(mockLlmConfigService.interactiveEditConfig).toHaveBeenCalledWith(baseConfig);
        expect(mockProgressIndicatorInstance.fail).toHaveBeenCalledWith(
          `Interactive config update failed: ${interactiveError.message}`
        );
        expect(mockLogger.error).toHaveBeenCalledWith(
          `Interactive config update failed: ${interactiveError.message}`
        );
        expect(mockProgressIndicatorInstance.succeed).not.toHaveBeenCalled();
        // expect(mockProgressIndicatorInstance.stop).toHaveBeenCalledTimes(1); // Stop is handled within service now
      });
    });

    // --- General Error Handling ---
    it('should handle unexpected errors during command execution', async () => {
      const interactiveOptions = {}; // Define options within the test scope
      const unexpectedError = new Error('Something broke');
      // Make the check for CLI options throw an error
      Object.defineProperty(interactiveOptions, 'provider', {
        get: () => {
          throw unexpectedError;
        },
      });

      const result = await (container as any).executeConfigCommand(interactiveOptions);

      expect(result.isErr()).toBe(true);
      expect(result.error?.message).toContain(`Config command failed: ${unexpectedError.message}`);
      expect(mockProgressIndicatorInstance.start).not.toHaveBeenCalled(); // Error before start
      expect(mockLlmConfigService.interactiveEditConfig).not.toHaveBeenCalled();
      expect(mockLlmConfigService.saveConfig).not.toHaveBeenCalled();
      expect(mockProgressIndicatorInstance.fail).toHaveBeenCalledWith(
        `Config command failed unexpectedly: ${unexpectedError.message}`
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        `Config command failed: ${unexpectedError.message}`,
        unexpectedError
      );
      expect(mockProgressIndicatorInstance.succeed).not.toHaveBeenCalled();
      // Stop might not be called if error is before try block, but fail() handles stopping
    });
  });

  // --- executeGenerateCommand ---
  describe('executeGenerateCommand', () => {
    it('should call generatorOrchestrator.execute with "generate" and options', async () => {
      const options = { generatorType: 'memory-bank', someOption: 'value' };
      mockGeneratorOrchestrator.execute.mockResolvedValue(Result.ok(undefined));

      // Need to access private method via 'any' for testing
      const result = await (container as any).executeGenerateCommand(options);

      expect(result.isOk()).toBe(true);
      expect(mockProgressIndicatorInstance.start).toHaveBeenCalledWith('Generating...');
      expect(mockGeneratorOrchestrator.execute).toHaveBeenCalledTimes(1);
      expect(mockGeneratorOrchestrator.execute).toHaveBeenCalledWith('generate', options);
      expect(mockProgressIndicatorInstance.succeed).toHaveBeenCalledWith(
        'Generation completed successfully.'
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "Generator orchestrator execution completed for 'generate' command."
      );
      expect(mockLogger.error).not.toHaveBeenCalled();
      expect(mockProgressIndicatorInstance.fail).not.toHaveBeenCalled();
    });

    it('should return an error if generatorOrchestrator.execute fails', async () => {
      const options = { generatorType: 'roo' };
      const orchestratorError = new Error('Orchestrator failed');
      mockGeneratorOrchestrator.execute.mockResolvedValue(Result.err(orchestratorError));

      const result = await (container as any).executeGenerateCommand(options);

      expect(result.isErr()).toBe(true);
      expect(result.error).toBe(orchestratorError);
      expect(mockProgressIndicatorInstance.start).toHaveBeenCalledWith('Generating...');
      expect(mockGeneratorOrchestrator.execute).toHaveBeenCalledTimes(1);
      expect(mockGeneratorOrchestrator.execute).toHaveBeenCalledWith('generate', options);
      expect(mockProgressIndicatorInstance.succeed).not.toHaveBeenCalled();
      expect(mockProgressIndicatorInstance.fail).toHaveBeenCalledWith(
        `Generator execution failed: ${orchestratorError.message}`
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        `Generator execution failed: ${orchestratorError.message}`
      );
    });

    it('should handle unexpected errors during execution', async () => {
      const options = { generatorType: 'cursor' };
      const unexpectedError = new Error('Unexpected generator error');
      mockGeneratorOrchestrator.execute.mockImplementation(() => {
        throw unexpectedError;
      });

      const result = await (container as any).executeGenerateCommand(options);

      expect(result.isErr()).toBe(true);
      expect(result.error?.message).toContain(
        `Generator execution failed: ${unexpectedError.message}`
      );
      expect(mockProgressIndicatorInstance.start).toHaveBeenCalledWith('Generating...');
      expect(mockGeneratorOrchestrator.execute).toHaveBeenCalledTimes(1);
      expect(mockGeneratorOrchestrator.execute).toHaveBeenCalledWith('generate', options);
      expect(mockProgressIndicatorInstance.succeed).not.toHaveBeenCalled();
      expect(mockProgressIndicatorInstance.fail).toHaveBeenCalledWith(
        `Generator execution failed: ${unexpectedError.message}`
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        `Generator execution failed: ${unexpectedError.message}`
      );
    });
  });

  // TODO: Add tests for run if needed, focusing on calls
});
