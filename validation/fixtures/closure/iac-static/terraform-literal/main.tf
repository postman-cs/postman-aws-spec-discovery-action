
resource "aws_api_gateway_rest_api" "orders" {
  name = "orders"
  body = <<EOF
{
  "openapi": "3.0.3",
  "info": {"title": "Orders", "version": "1.0.0"},
  "paths": {
    "/orders": {
      "get": {
        "operationId": "listOrders",
        "responses": {"200": {"description": "ok"}}
      }
    }
  }
}
EOF
}

output "rest_api_id" {
  value = "tfapiid001"
}
