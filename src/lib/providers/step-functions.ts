import type { StepFunctionsSpecClient } from '../aws/step-functions-client.js';
import type { ExportOptions, SpecCandidate, SpecExportResult, SpecProvider } from './types.js';

export class StepFunctionsProvider implements SpecProvider {
  public readonly type = 'step-functions' as const;

  public constructor(private readonly client: StepFunctionsSpecClient) {}

  public async probe(): Promise<boolean> {
    return this.client.probe();
  }

  public async listCandidates(): Promise<SpecCandidate[]> {
    return (await this.client.listStateMachines()).map((stateMachine) => ({
      id: stateMachine.arn,
      name: stateMachine.name,
      providerType: 'step-functions',
      tags: {},
      evidence: [`Step Functions state machine discovered: ${stateMachine.name}`],
      meta: {
        stateMachineArn: stateMachine.arn,
        type: stateMachine.type ?? ''
      }
    }));
  }

  public async exportSpec(candidate: SpecCandidate, _options?: ExportOptions): Promise<SpecExportResult> {
    void _options;
    const detail = await this.client.describeStateMachine(candidate.meta.stateMachineArn || candidate.id);
    const path = `/step-functions/${safePath(detail.name)}/executions`;
    const document = {
      openapi: '3.1.0',
      info: {
        title: detail.name,
        version: '1.0.0',
        description: 'Partial Step Functions surface derived from Amazon States Language workflow metadata.'
      },
      paths: {
        [path]: {
          post: {
            operationId: `start${pascal(detail.name)}Execution`,
            summary: `Start ${detail.name} state machine execution`,
            'x-aws-stepfunctions': {
              stateMachineArn: detail.arn,
              type: detail.type,
              status: detail.status,
              revisionId: detail.revisionId,
              definition: parseDefinition(detail.definition)
            },
            requestBody: {
              required: false,
              content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } }
            },
            responses: { '202': { description: 'State machine execution started' } }
          }
        }
      },
      'x-aws-stepfunctions': {
        stateMachineArn: detail.arn,
        type: detail.type,
        status: detail.status,
        revisionId: detail.revisionId
      }
    };
    return {
      content: `${JSON.stringify(document, null, 2)}\n`,
      format: 'openapi-json',
      filename: 'index.json',
      derivedOpenApiCompleteness: 'partial',
      evidence: [`Synthesized partial OpenAPI operation from Step Functions ASL for ${detail.name}`]
    };
  }
}

function parseDefinition(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function safePath(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function pascal(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9]+(.)/g, (_match, chr: string) => chr.toUpperCase())
    .replace(/^([a-z])/, (match) => match.toUpperCase());
}
