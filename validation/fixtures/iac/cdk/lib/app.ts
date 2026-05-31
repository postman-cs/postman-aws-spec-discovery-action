import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as events from 'aws-cdk-lib/aws-events';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import { SnsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';

new apigateway.RestApi({} as never, 'ValidationRestApi');
new apigatewayv2.HttpApi({} as never, 'ValidationHttpApi');
new appsync.GraphqlApi({} as never, 'ValidationGraphqlApi', {} as never);
new events.EventBus({} as never, 'ValidationBus');
const topic = new sns.Topic({} as never, 'ValidationTopic');
sns.Topic.fromTopicArn({} as never, 'ImportedTopic', 'arn:aws:sns:us-east-1:123456789012:validation-topic');
new SnsEventSource(topic);
const validationAuthType = lambda.FunctionUrlAuthType.AWS_IAM;
({} as lambda.Function).addFunctionUrl({ authType: validationAuthType });
