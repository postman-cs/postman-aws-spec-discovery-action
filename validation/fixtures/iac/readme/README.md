# Validation Service

The production API is deployed at https://api.validation.example.test/v1.

Gateway hints:

- REST_API_ID=abcdef1234
- https://abcdef1234.execute-api.us-east-1.amazonaws.com/prod
- Lambda Function URL: abcdefghij.lambda-url.us-east-1.on.aws
- SNS bridge: messages publish to arn:aws:sns:us-east-1:123456789012:validation-topic, then Lambda forwards to EventBridge.
