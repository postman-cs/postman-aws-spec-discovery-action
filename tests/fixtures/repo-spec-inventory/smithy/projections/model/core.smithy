$version: "2"

namespace example.projections

service ProjectionService {
    version: "2026-07-19",
    operations: [Ping]
}

operation Ping {
    output: PingOutput
}

structure PingOutput {
    ok: Boolean
}
