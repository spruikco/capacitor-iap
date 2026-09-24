// swift-tools-version: 5.9
import PackageDescription

// ⚠️ THE PACKAGE NAME AND THE LIBRARY PRODUCT NAME ARE NOT FREE CHOICES.
//
// `cap sync` generates ios/App/CapApp-SPM/Package.swift and refers to this
// package by `fixName(<npm package name>)` (@capacitor/cli/dist/plugin.js):
//
//     '@spruik/capacitor-iap'
//       -> '/'  => '_'   ->  '@spruik_capacitor-iap'
//       -> '-'  => '_'   ->  '@spruik_capacitor_iap'
//       -> '@'  => ''    ->  'spruik_capacitor_iap'
//       -> '_x' => 'X'   ->  'spruikCapacitorIap'
//       -> ucfirst        ->  'SpruikCapacitorIap'
//
// It then writes BOTH of these lines into the app's Package.swift:
//
//     .package(name: "SpruikCapacitorIap", path: "../../packages/capacitor-iap")
//     .product(name: "SpruikCapacitorIap", package: "SpruikCapacitorIap")
//
// So the package name and the library product name below must both be exactly
// "SpruikCapacitorIap". Renaming the npm package without renaming these (or the
// reverse) produces an SPM resolution failure on the build machine only, long
// after it would have been cheap to notice. The target name is unconstrained.
//
// iOS 15 is the floor because StoreKit 2 (`Product`, `Transaction`) needs it.
// The Capacitor 8 app template already targets 15.0, so this costs us nothing.

let package = Package(
    name: "SpruikCapacitorIap",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "SpruikCapacitorIap",
            targets: ["IapPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "IapPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/IapPlugin")
    ]
)
