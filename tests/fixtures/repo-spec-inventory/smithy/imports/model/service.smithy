$version: "2"

namespace example.imports

use example.shared#SharedId

service ImportService {
    version: "2026-07-19",
    operations: [GetShared]
}

operation GetShared {
    input: SharedId,
    output: SharedId
}
