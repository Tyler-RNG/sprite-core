// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "SpriteCoreClient",
    platforms: [
        .iOS(.v15),
        .macOS(.v12),
        .tvOS(.v15),
        .watchOS(.v8),
    ],
    products: [
        .library(
            name: "SpriteCoreClient",
            targets: ["SpriteCoreClient"]
        ),
    ],
    dependencies: [],
    targets: [
        .target(
            name: "SpriteCoreClient",
            path: "Sources/SpriteCoreClient"
        ),
        .testTarget(
            name: "SpriteCoreClientTests",
            dependencies: ["SpriteCoreClient"],
            path: "Tests/SpriteCoreClientTests"
        ),
    ]
)
