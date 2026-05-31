import * as aws from '@pulumi/aws';

new aws.apigateway.RestApi('validation-rest-api');
new aws.apigatewayv2.Api('validation-http-api', { protocolType: 'HTTP' });
new aws.appsync.GraphQLApi('validation-graphql', { authenticationType: 'API_KEY' });
new aws.sns.Topic('validation-topic');
new aws.lambda.FunctionUrl('validation-function-url', {
  functionName: 'validation-function',
  authorizationType: 'AWS_IAM'
});
