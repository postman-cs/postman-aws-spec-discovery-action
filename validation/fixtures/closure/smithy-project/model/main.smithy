$version: "2"

namespace example.orders

service OrderService {
    version: "2026-07-19",
    operations: [GetOrder]
}

operation GetOrder {
    input: GetOrderInput,
    output: GetOrderOutput
}

structure GetOrderInput {
    @required
    id: String
}

structure GetOrderOutput {
    id: String
}
