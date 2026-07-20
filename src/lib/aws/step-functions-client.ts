import {
  DescribeStateMachineCommand,
  ListStateMachinesCommand,
  SFNClient,
  type DescribeStateMachineOutput,
  type StateMachineListItem
} from '@aws-sdk/client-sfn';
import { NodeHttpHandler } from '@smithy/node-http-handler';

import { createAwsPaginationGuard } from './pagination.js';

export interface StepFunctionStateMachineSummary {
  name: string;
  arn: string;
  type?: string;
}

export interface StepFunctionStateMachineDetail extends StepFunctionStateMachineSummary {
  definition: string;
  status?: string;
  revisionId?: string;
}

export interface StepFunctionsSpecClient {
  listStateMachines(): Promise<StepFunctionStateMachineSummary[]>;
  describeStateMachine(arn: string): Promise<StepFunctionStateMachineDetail>;
  probe(): Promise<boolean>;
}

export class StepFunctionsSdkClient implements StepFunctionsSpecClient {
  private readonly client: SFNClient;

  public constructor(region: string, options: { requestTimeoutMs?: number; maxAttempts?: number } = {}) {
    const requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.client = new SFNClient({
      region,
      maxAttempts: options.maxAttempts ?? 3,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: requestTimeoutMs,
        socketTimeout: requestTimeoutMs
      })
    });
  }

  public async listStateMachines(): Promise<StepFunctionStateMachineSummary[]> {
    const stateMachines: StepFunctionStateMachineSummary[] = [];
    const guard = createAwsPaginationGuard('Step Functions ListStateMachines');
    let nextToken: string | undefined;
    do {
      guard.beginPage();
      const response = await this.client.send(new ListStateMachinesCommand({ nextToken, maxResults: 100 }));
      for (const stateMachine of response.stateMachines ?? []) {
        const mapped = mapStateMachine(stateMachine);
        if (mapped) stateMachines.push(mapped);
      }
      nextToken = guard.takeNextToken(response.nextToken);
    } while (nextToken);
    return stateMachines;
  }

  public async describeStateMachine(arn: string): Promise<StepFunctionStateMachineDetail> {
    const response = await this.client.send(new DescribeStateMachineCommand({ stateMachineArn: arn }));
    return mapStateMachineDetail(response, arn);
  }

  public async probe(): Promise<boolean> {
    try {
      await this.client.send(new ListStateMachinesCommand({ maxResults: 1 }));
      return true;
    } catch {
      return false;
    }
  }
}

function mapStateMachine(stateMachine: StateMachineListItem): StepFunctionStateMachineSummary | undefined {
  if (!stateMachine.name || !stateMachine.stateMachineArn) return undefined;
  return {
    name: stateMachine.name,
    arn: stateMachine.stateMachineArn,
    type: stateMachine.type
  };
}

function mapStateMachineDetail(response: DescribeStateMachineOutput, fallbackArn: string): StepFunctionStateMachineDetail {
  return {
    name: response.name ?? fallbackArn.split(':').pop() ?? fallbackArn,
    arn: response.stateMachineArn ?? fallbackArn,
    type: response.type,
    definition: response.definition ?? '{}',
    status: response.status,
    revisionId: response.revisionId
  };
}
