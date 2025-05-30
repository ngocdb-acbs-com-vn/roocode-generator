import path from 'path';
import { Injectable, Inject } from '../core/di/decorators';
import { IMemoryBankValidator, MemoryBankFileType, TemplateType } from './interfaces';
import { IFileOperations } from '../core/file-operations/interfaces';
import { ILogger } from '../core/services/logger-service';
import { Result } from '../core/result/result';
import { MemoryBankValidationError } from '../core/errors/memory-bank-errors';

@Injectable()
export class MemoryBankValidator implements IMemoryBankValidator {
  constructor(
    @Inject('IFileOperations') private readonly fileOps: IFileOperations,
    @Inject('ILogger') private readonly logger: ILogger
  ) {}

  async validateRequiredFiles(baseDir: string): Promise<Result<void>> {
    try {
      const memoryBankDir = path.join(baseDir, 'memory-bank');
      const templateDir = path.join(baseDir, 'templates', 'memory-bank', 'templates');

      const missingFiles: string[] = [];

      // Check memory bank files
      for (const typeToGenerate of Object.values(MemoryBankFileType)) {
        const filePath = path.join(memoryBankDir, `${String(typeToGenerate)}.md`);
        const readResult = await this.fileOps.readFile(filePath);
        if (readResult.isErr()) {
          missingFiles.push(`Missing required memory bank file: ${String(typeToGenerate)}.md`);
        }
      }

      // Check template files
      for (const templateType of Object.values(TemplateType)) {
        const filePath = path.join(templateDir, `${templateType}-template.md`);
        const readResult = await this.fileOps.readFile(filePath);
        if (readResult.isErr()) {
          missingFiles.push(`Missing required template file: ${templateType}-template.md`);
        }
      }

      if (missingFiles.length > 0) {
        return Result.err(
          new MemoryBankValidationError('Missing required memory bank or template files', {
            missingFiles,
          })
        );
      }

      return Result.ok(undefined);
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      const validationError = new MemoryBankValidationError(
        'Error validating memory bank files',
        { operation: 'validateRequiredFiles' },
        cause
      );
      this.logger.error(validationError.message, validationError);
      return Result.err(validationError);
    }
  }

  async validateTemplateFiles(_baseDir: string): Promise<Result<void>> {
    // This method is kept for interface compatibility but is not currently used
    this.logger.debug('validateTemplateFiles called but not implemented');
    await Promise.resolve(); // Keep async nature
    return Result.ok(undefined);
  }

  validateFileContent(content: string, type: MemoryBankFileType): Result<void> {
    // Basic validation example: check if content is non-empty
    if (!content || content.trim().length === 0) {
      return Result.err(
        new MemoryBankValidationError(`Content for ${String(type)} is empty or whitespace`, {
          fileType: String(type),
          operation: 'validateFileContent',
        })
      );
    }
    return Result.ok(undefined);
  }
}
