
resource "aws_api_gateway_rest_api" "orders" {
  name = "orders"
  body = templatefile("${path.module}/openapi/orders.json", {
    title = var.api_title
  })
}

output "computed" {
  value = aws_api_gateway_rest_api.orders.id
}
