export interface SafetyConfig {
  allowedIncomingModes: string[];
  allowedOutgoingModes: string[];
  excludedIncomingOperations: string[];
  excludedOutgoingOperations: string[];
  maxBatchSize: number;
  requireConfirmation: string[];
  rateLimits: {
    operationsPerMinute: number;
    operationsPerHour: number;
  };
}

export interface OperationContext {
  source: 'confluence' | 'jira' | 'external';
  operation: string;
  targetServer?: string;
  batchSize?: number;
  timestamp: number;
}

export interface ValidationResult {
  allowed: boolean;
  reason?: string;
  requires_confirmation?: boolean;
  rate_limited?: boolean;
}

export class SafetyBoundariesManager {
  private operationHistory: OperationContext[] = [];
  private blockedOperations = new Set<string>();

  constructor(private config: SafetyConfig) {
    this.cleanupHistory();

    // Set up periodic cleanup
    setInterval(() => this.cleanupHistory(), 60000); // Every minute
  }

  validateIncomingOperation(operation: string, context: OperationContext): ValidationResult {
    // Check if operation is in excluded list
    if (this.config.excludedIncomingOperations.includes(operation)) {
      return {
        allowed: false,
        reason: `Operation '${operation}' is explicitly excluded for incoming requests`,
      };
    }

    // Check operation mode
    const mode = this.getOperationMode(operation);
    if (!this.config.allowedIncomingModes.includes(mode)) {
      return {
        allowed: false,
        reason: `Operation mode '${mode}' is not allowed for incoming requests`,
      };
    }

    // Check rate limits
    const rateLimitResult = this.checkRateLimit(context);
    if (rateLimitResult.rate_limited) {
      return rateLimitResult;
    }

    // Check batch size
    if (context.batchSize && context.batchSize > this.config.maxBatchSize) {
      return {
        allowed: false,
        reason: `Batch size ${context.batchSize} exceeds maximum allowed size of ${this.config.maxBatchSize}`,
      };
    }

    // Check if operation requires confirmation
    const requiresConfirmation = this.config.requireConfirmation.includes(operation);

    return {
      allowed: true,
      requires_confirmation: requiresConfirmation,
    };
  }

  validateOutgoingOperation(operation: string, context: OperationContext): ValidationResult {
    // Check if operation is in excluded list
    if (this.config.excludedOutgoingOperations.includes(operation)) {
      return {
        allowed: false,
        reason: `Operation '${operation}' is explicitly excluded for outgoing requests`,
      };
    }

    // Check operation mode
    const mode = this.getOperationMode(operation);
    if (!this.config.allowedOutgoingModes.includes(mode)) {
      return {
        allowed: false,
        reason: `Operation mode '${mode}' is not allowed for outgoing requests`,
      };
    }

    // Check if operation is temporarily blocked
    if (this.blockedOperations.has(operation)) {
      return {
        allowed: false,
        reason: `Operation '${operation}' is temporarily blocked due to previous failures`,
      };
    }

    // Check rate limits
    const rateLimitResult = this.checkRateLimit(context);
    if (rateLimitResult.rate_limited) {
      return rateLimitResult;
    }

    // Check batch size
    if (context.batchSize && context.batchSize > this.config.maxBatchSize) {
      return {
        allowed: false,
        reason: `Batch size ${context.batchSize} exceeds maximum allowed size of ${this.config.maxBatchSize}`,
      };
    }

    return { allowed: true };
  }

  private getOperationMode(operation: string): string {
    const lowerOp = operation.toLowerCase();

    if (lowerOp.includes('delete') || lowerOp.includes('remove') || lowerOp.includes('destroy')) {
      return 'delete';
    }
    if (
      lowerOp.includes('update') ||
      lowerOp.includes('edit') ||
      lowerOp.includes('modify') ||
      lowerOp.includes('patch')
    ) {
      return 'update';
    }
    if (
      lowerOp.includes('create') ||
      lowerOp.includes('add') ||
      lowerOp.includes('insert') ||
      lowerOp.includes('post')
    ) {
      return 'create';
    }
    return 'read';
  }

  private checkRateLimit(_context: OperationContext): ValidationResult {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    const oneHourAgo = now - 3600000;

    // Count operations in the last minute and hour
    const recentOperations = this.operationHistory.filter((op) => op.timestamp > oneMinuteAgo);
    const hourlyOperations = this.operationHistory.filter((op) => op.timestamp > oneHourAgo);

    if (recentOperations.length >= this.config.rateLimits.operationsPerMinute) {
      return {
        allowed: false,
        rate_limited: true,
        reason: `Rate limit exceeded: ${recentOperations.length} operations in the last minute (limit: ${this.config.rateLimits.operationsPerMinute})`,
      };
    }

    if (hourlyOperations.length >= this.config.rateLimits.operationsPerHour) {
      return {
        allowed: false,
        rate_limited: true,
        reason: `Rate limit exceeded: ${hourlyOperations.length} operations in the last hour (limit: ${this.config.rateLimits.operationsPerHour})`,
      };
    }

    return { allowed: true };
  }

  recordOperation(context: OperationContext): void {
    this.operationHistory.push({
      ...context,
      timestamp: Date.now(),
    });
  }

  blockOperation(operation: string, durationMs = 300000): void {
    this.blockedOperations.add(operation);

    setTimeout(() => {
      this.blockedOperations.delete(operation);
    }, durationMs);
  }

  isOperationBlocked(operation: string): boolean {
    return this.blockedOperations.has(operation);
  }

  private cleanupHistory(): void {
    const cutoff = Date.now() - 3600000; // Remove operations older than 1 hour
    this.operationHistory = this.operationHistory.filter((op) => op.timestamp > cutoff);
  }

  getOperationStats(): {
    totalOperations: number;
    operationsLastMinute: number;
    operationsLastHour: number;
    blockedOperations: string[];
    topOperations: { operation: string; count: number }[];
  } {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    const oneHourAgo = now - 3600000;

    const lastMinute = this.operationHistory.filter((op) => op.timestamp > oneMinuteAgo);
    const lastHour = this.operationHistory.filter((op) => op.timestamp > oneHourAgo);

    // Count operations by type
    const operationCounts = new Map<string, number>();
    this.operationHistory.forEach((op) => {
      const count = operationCounts.get(op.operation) || 0;
      operationCounts.set(op.operation, count + 1);
    });

    const topOperations = Array.from(operationCounts.entries())
      .map(([operation, count]) => ({ operation, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      totalOperations: this.operationHistory.length,
      operationsLastMinute: lastMinute.length,
      operationsLastHour: lastHour.length,
      blockedOperations: Array.from(this.blockedOperations),
      topOperations,
    };
  }

  updateConfig(newConfig: Partial<SafetyConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  getConfig(): SafetyConfig {
    return { ...this.config };
  }

  // Utility methods for common validations

  validatePageOperation(
    operation: string,
    pageId: string,
    context: OperationContext
  ): ValidationResult {
    // Additional page-specific validations
    if (!pageId || typeof pageId !== 'string') {
      return {
        allowed: false,
        reason: 'Invalid or missing page ID',
      };
    }

    // Check for dangerous operations on important pages
    if (this.getOperationMode(operation) === 'delete') {
      // Could add checks for system pages, templates, etc.
      return {
        allowed: true,
        requires_confirmation: true,
      };
    }

    return this.validateOutgoingOperation(operation, context);
  }

  validateSpaceOperation(
    operation: string,
    spaceId: string,
    context: OperationContext
  ): ValidationResult {
    // Additional space-specific validations
    if (!spaceId || typeof spaceId !== 'string') {
      return {
        allowed: false,
        reason: 'Invalid or missing space ID',
      };
    }

    // Space operations are typically more sensitive
    const mode = this.getOperationMode(operation);
    if (mode === 'delete' || mode === 'update') {
      return {
        allowed: true,
        requires_confirmation: true,
      };
    }

    return this.validateOutgoingOperation(operation, context);
  }

  validateJiraOperation(
    operation: string,
    issueKey: string,
    context: OperationContext
  ): ValidationResult {
    // Additional Jira-specific validations
    if (!issueKey || typeof issueKey !== 'string') {
      return {
        allowed: false,
        reason: 'Invalid or missing Jira issue key',
      };
    }

    // Check issue key format (basic validation)
    if (!/^[A-Z]+-\d+$/.test(issueKey)) {
      return {
        allowed: false,
        reason: 'Invalid Jira issue key format',
      };
    }

    return this.validateOutgoingOperation(operation, context);
  }
}

// Default safety configuration
export async function createDefaultSafetyConfig(): Promise<SafetyConfig> {
  try {
    const { getCrossServerConfig } = await import('../config.js');
    const crossServerConfig = await getCrossServerConfig();

    if (crossServerConfig?.safetyBoundaries) {
      return crossServerConfig.safetyBoundaries;
    }
  } catch (error) {
    // Failed to load cross-server config - use fallback
  }

  // Fallback to environment variables
  return {
    allowedIncomingModes: (process.env.ALLOWED_INCOMING_MODES || 'read,create').split(','),
    allowedOutgoingModes: (process.env.ALLOWED_OUTGOING_MODES || 'read,create,update').split(','),
    excludedIncomingOperations: (
      process.env.EXCLUDED_INCOMING_OPERATIONS ||
      'delete_confluence_page,delete_confluence_space,update_confluence_page'
    ).split(','),
    excludedOutgoingOperations: (
      process.env.EXCLUDED_OUTGOING_OPERATIONS || 'delete_issue,delete_project'
    ).split(','),
    maxBatchSize: parseInt(process.env.MAX_CROSS_SERVER_BATCH || '10'),
    requireConfirmation: (
      process.env.REQUIRE_CONFIRMATION_OPERATIONS || 'delete_confluence_page,update_confluence_page'
    ).split(','),
    rateLimits: {
      operationsPerMinute: parseInt(process.env.RATE_LIMIT_PER_MINUTE || '30'),
      operationsPerHour: parseInt(process.env.RATE_LIMIT_PER_HOUR || '1000'),
    },
  };
}

// Global safety manager instance - will be initialized async
let safetyManagerInstance: SafetyBoundariesManager | null = null;

export async function getSafetyManager(): Promise<SafetyBoundariesManager> {
  if (!safetyManagerInstance) {
    const config = await createDefaultSafetyConfig();
    safetyManagerInstance = new SafetyBoundariesManager(config);
  }
  return safetyManagerInstance;
}

// Legacy export for backwards compatibility
export const safetyManager = new SafetyBoundariesManager({
  allowedIncomingModes: ['read', 'create'],
  allowedOutgoingModes: ['read', 'create', 'update'],
  excludedIncomingOperations: [],
  excludedOutgoingOperations: [],
  maxBatchSize: 100,
  requireConfirmation: [],
  rateLimits: {
    operationsPerMinute: 1000,
    operationsPerHour: 10000,
  },
});
