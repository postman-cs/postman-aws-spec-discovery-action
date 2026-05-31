$version: "2"

namespace validation

service ValidationService {
    version: "2026-05-31",
    operations: [GetItem]
}

operation GetItem {
    input: GetItemInput,
    output: GetItemOutput
}

structure GetItemInput {
    @required
    id: String
}

structure GetItemOutput {
    id: String,
    name: String
}
