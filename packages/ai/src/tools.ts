import { t } from '@doc77/core';
import type { ToolDefinition } from '../provider/index.js';

/**
 * MCP Read Tool Definitions — OpenAI Function Calling format.
 *
 * These are the read-only tools the AI agent can use to explore
 * the project's file system. Write tools are deferred to Phase 5.
 *
 * Factory function (not a module-level constant) so that t() is evaluated
 * after initI18n() has been called, ensuring the correct locale is used.
 */
export function getReadTools(): ToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'list_files',
        description: t('ai.tool.listFiles.desc'),
        parameters: {
          type: 'object',
          properties: {
            dir_path: {
              type: 'string',
              description: t('ai.tool.listFiles.dirPath'),
            },
          },
          required: ['dir_path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: t('ai.tool.readFile.desc'),
        parameters: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: t('ai.tool.readFile.filePath'),
            },
          },
          required: ['file_path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_file_info',
        description: t('ai.tool.getFileInfo.desc'),
        parameters: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: t('ai.tool.getFileInfo.filePath'),
            },
          },
          required: ['file_path'],
        },
      },
    },
  ];
}

/**
 * MCP Write Tool Definitions — OpenAI Function Calling format.
 *
 * These let the AI agent *propose* file mutations. They never execute directly:
 * the executor enqueues each as a pending task in the approval queue, and the
 * user approves it in the UI before the transactional executor runs it. Every
 * description states that approval is required so the model sets expectations.
 *
 * Factory function (not a module-level constant) so that t() is evaluated
 * after initI18n() has been called, ensuring the correct locale is used.
 */
export function getWriteTools(): ToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'move_file',
        description: t('ai.tool.moveFile.desc'),
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string', description: t('ai.tool.moveFile.source') },
            target: { type: 'string', description: t('ai.tool.moveFile.target') },
          },
          required: ['source', 'target'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_folder',
        description: t('ai.tool.createFolder.desc'),
        parameters: {
          type: 'object',
          properties: {
            folder_path: { type: 'string', description: t('ai.tool.createFolder.folderPath') },
          },
          required: ['folder_path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_file',
        description: t('ai.tool.deleteFile.desc'),
        parameters: {
          type: 'object',
          properties: {
            file_path: { type: 'string', description: t('ai.tool.deleteFile.filePath') },
          },
          required: ['file_path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'batch_operations',
        description: t('ai.tool.batchOperations.desc'),
        parameters: {
          type: 'object',
          properties: {
            operations: {
              type: 'array',
              description: t('ai.tool.batchOperations.operations'),
              items: {
                type: 'object',
                description: t('ai.tool.batchOperations.operationsItemDesc'),
                properties: {
                  type: {
                    type: 'string',
                    enum: ['move_file', 'create_folder', 'delete_file'],
                    description: t('ai.tool.batchOperations.type'),
                  },
                  source: { type: 'string', description: t('ai.tool.batchOperations.source') },
                  target: { type: 'string', description: t('ai.tool.batchOperations.target') },
                  folder_path: {
                    type: 'string',
                    description: t('ai.tool.batchOperations.folderPath'),
                  },
                  file_path: { type: 'string', description: t('ai.tool.batchOperations.filePath') },
                },
                required: ['type'],
              },
            },
          },
          required: ['operations'],
        },
      },
    },
  ];
}
