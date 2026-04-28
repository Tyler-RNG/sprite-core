import XCTest
@testable import SpriteCoreClient

final class AvatarMarkerParserTests: XCTestCase {
    func testResolveStateAndCount_bare() {
        let r = resolveStateAndCount("happy")
        XCTAssertEqual(r.state, "happy")
        XCTAssertNil(r.count)
    }

    func testResolveStateAndCount_withNumericSuffix() {
        let r = resolveStateAndCount("happy-3")
        XCTAssertEqual(r.state, "happy")
        XCTAssertEqual(r.count, 3)
    }

    func testResolveStateAndCount_dashHyphenatedName() {
        let r = resolveStateAndCount("head-cocked")
        XCTAssertEqual(r.state, "head-cocked")
        XCTAssertNil(r.count)
    }

    func testStripsSingleMarker() {
        let p = AvatarMarkerParser()
        let r = p.push("hello <<<happy>>> world")
        XCTAssertEqual(r.cleanedText, "hello  world")
        XCTAssertEqual(r.markers, [AvatarMarker(state: "happy")])
    }

    func testRecognisesMarkerSplitAcrossChunks() {
        let p = AvatarMarkerParser()
        let a = p.push("start <<<hap")
        let b = p.push("py>>> end")
        XCTAssertEqual(a.cleanedText + b.cleanedText, "start  end")
        XCTAssertEqual(a.markers + b.markers, [AvatarMarker(state: "happy")])
    }

    func testPlayCountMarker() {
        let r = parseAvatarMarkers("say <<<wink-1>>> it")
        XCTAssertEqual(r.markers, [AvatarMarker(state: "wink", count: 1)])
    }

    func testInvalidMarkerStaysLiteral() {
        let r = parseAvatarMarkers("bad <<<has space>>> marker")
        XCTAssertEqual(r.cleanedText, "bad <<<has space>>> marker")
        XCTAssertTrue(r.markers.isEmpty)
    }

    func testSplitByMarkers_countForwarded() {
        let segs = splitByMarkers("<<<wink-2>>> hello")
        XCTAssertEqual(segs, [TextSegmentWithEmotion(text: " hello", emotion: "wink", emotionCount: 2)])
    }
}
