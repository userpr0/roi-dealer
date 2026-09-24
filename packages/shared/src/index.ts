export {
  ConfigValidationError,
  loadConfig,
  nodeEnvSchema,
  portSchema,
  type ConfigIssue,
  type EnvSource,
  type NodeEnv,
} from './config.js';
export {
  createShutdownManager,
  exitProcess,
  installProcessHandlers,
  type LifecycleLogger,
  type ProcessHandlerOptions,
  type ShutdownHook,
  type ShutdownManager,
  type ShutdownManagerOptions,
} from './lifecycle.js';
export { uuidv7 } from './uuid.js';

export const PACKAGE_NAME = '@roi-dealer/shared';
