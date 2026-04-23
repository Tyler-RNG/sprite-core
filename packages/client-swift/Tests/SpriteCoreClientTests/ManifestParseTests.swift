import XCTest
@testable import SpriteCoreClient

final class ManifestParseTests: XCTestCase {
    func testDecodesMinimalHeadshotManifest() throws {
        let json = """
        {
          "version": 1,
          "agentId": "ginger",
          "modes": ["headshot"],
          "stateMap": { "idle": "idle" },
          "content": {
            "headshot": {
              "animations": {
                "idle": {
                  "sequence": {
                    "frames": [{ "ref": "idle.00" }],
                    "fps": 12,
                    "loop": "infinite"
                  }
                }
              }
            }
          },
          "assets": {
            "refs": { "idle.00": "atlas/idle_00.webp" }
          }
        }
        """
        let manifest = try JSONDecoder().decode(CharacterManifest.self, from: Data(json.utf8))
        XCTAssertEqual(manifest.agentId, "ginger")
        XCTAssertEqual(manifest.modes, ["headshot"])
        let content = try XCTUnwrap(manifest.content["headshot"])
        let idle = try XCTUnwrap(content.animations["idle"])
        XCTAssertEqual(idle.sequence?.frames.count, 1)
    }

    func testDecodesTransitionRefStringAndCrossfade() throws {
        let json = """
        {
          "version": 1,
          "agentId": "a",
          "modes": ["m"],
          "stateMap": {},
          "content": {
            "m": {
              "animations": { "x": { "sequence": { "frames": [{ "ref": "r" }], "fps": 12, "loop": "once" } } },
              "transitions": {
                "*->*": "x.intro",
                "a->b": { "blend": "crossfade", "ms": 150 }
              }
            }
          },
          "assets": { "refs": { "r": "path" } }
        }
        """
        let m = try JSONDecoder().decode(CharacterManifest.self, from: Data(json.utf8))
        let content = try XCTUnwrap(m.content["m"])
        let t = try XCTUnwrap(content.transitions)
        guard case .phase(let s) = t["*->*"]! else { return XCTFail("expected phase ref") }
        XCTAssertEqual(s, "x.intro")
        guard case .crossfade(let ms) = t["a->b"]! else { return XCTFail("expected crossfade") }
        XCTAssertEqual(ms, 150)
    }
}
