from aws_cdk import aws_apigatewayv2 as apigatewayv2

api = apigatewayv2.CfnApi(None, "OrdersApi", protocol_type="HTTP")
