
resource "aws_apigatewayv2_api" "orders" {
  name          = "orders"
  protocol_type = "HTTP"
  body          = file("openapi/orders.json")
}

output "http_api_id" {
  value = "tfhttpapi1"
}
