resource "aws_api_gateway_rest_api" "validation" {
  name = "validation-rest-api"
}

resource "aws_apigatewayv2_api" "validation_http" {
  name          = "validation-http-api"
  protocol_type = "HTTP"
}

resource "aws_appsync_graphql_api" "validation" {
  name                = "validation-graphql"
  authentication_type = "API_KEY"
}

resource "aws_schemas_schema" "validation" {
  name          = "validation-event"
  registry_name = "validation-registry"
  type          = "OpenApi3"
  content       = jsonencode({ openapi = "3.0.0", info = { title = "validation", version = "1.0.0" }, paths = {} })
}

resource "aws_cloudwatch_event_bus" "validation" {
  name = "validation-bus"
}

resource "aws_glue_schema" "validation" {
  schema_name       = "validation-schema"
  registry_arn      = "arn:aws:glue:us-east-1:123456789012:registry/validation"
  data_format       = "JSON"
  compatibility     = "NONE"
  schema_definition = jsonencode({ type = "object" })
}

resource "aws_sns_topic" "validation" {
  name = "validation-topic"
}

resource "aws_sns_topic_subscription" "validation" {
  topic_arn = aws_sns_topic.validation.arn
  protocol  = "lambda"
  endpoint  = "arn:aws:lambda:us-east-1:123456789012:function:validation-bridge"
}

resource "aws_lambda_function_url" "validation" {
  function_name      = "validation-function"
  authorization_type = "AWS_IAM"
}
