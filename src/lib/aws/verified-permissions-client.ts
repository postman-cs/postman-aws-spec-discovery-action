import {
  GetSchemaCommand,
  ListPolicyStoresCommand,
  VerifiedPermissionsClient,
  type PolicyStoreItem
} from '@aws-sdk/client-verifiedpermissions';
import { NodeHttpHandler } from '@smithy/node-http-handler';

export interface VerifiedPermissionsPolicyStoreSummary {
  policyStoreId: string;
  arn: string;
  description?: string;
}

export interface VerifiedPermissionsSchemaDetail {
  policyStoreId: string;
  schema?: string;
  namespaces?: string[];
}

export interface VerifiedPermissionsSpecClient {
  listPolicyStores(): Promise<VerifiedPermissionsPolicyStoreSummary[]>;
  getSchema(policyStoreId: string): Promise<VerifiedPermissionsSchemaDetail>;
  probe(): Promise<boolean>;
}

export class VerifiedPermissionsSdkClient implements VerifiedPermissionsSpecClient {
  private readonly client: VerifiedPermissionsClient;

  public constructor(region: string, options: { requestTimeoutMs?: number; maxAttempts?: number } = {}) {
    const requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.client = new VerifiedPermissionsClient({
      region,
      maxAttempts: options.maxAttempts ?? 3,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: requestTimeoutMs,
        socketTimeout: requestTimeoutMs
      })
    });
  }

  public async listPolicyStores(): Promise<VerifiedPermissionsPolicyStoreSummary[]> {
    const stores: VerifiedPermissionsPolicyStoreSummary[] = [];
    let nextToken: string | undefined;
    do {
      const response = await this.client.send(new ListPolicyStoresCommand({ nextToken, maxResults: 50 }));
      for (const store of response.policyStores ?? []) {
        const mapped = mapPolicyStore(store);
        if (mapped) stores.push(mapped);
      }
      nextToken = response.nextToken;
    } while (nextToken);
    return stores;
  }

  public async getSchema(policyStoreId: string): Promise<VerifiedPermissionsSchemaDetail> {
    const response = await this.client.send(new GetSchemaCommand({ policyStoreId }));
    return {
      policyStoreId: response.policyStoreId ?? policyStoreId,
      schema: response.schema,
      namespaces: response.namespaces
    };
  }

  public async probe(): Promise<boolean> {
    try {
      await this.client.send(new ListPolicyStoresCommand({ maxResults: 1 }));
      return true;
    } catch {
      return false;
    }
  }
}

function mapPolicyStore(store: PolicyStoreItem): VerifiedPermissionsPolicyStoreSummary | undefined {
  if (!store.policyStoreId || !store.arn) return undefined;
  return {
    policyStoreId: store.policyStoreId,
    arn: store.arn,
    description: store.description
  };
}
