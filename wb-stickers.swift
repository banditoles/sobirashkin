import Foundation
import CoreGraphics
import ImageIO

struct Sticker: Decodable {
    let png: String
}

func makePDF() throws -> Data {
    let stickers = try JSONDecoder().decode([Sticker].self, from: FileHandle.standardInput.readDataToEndOfFile())
    let output = NSMutableData()
    var page = CGRect(x: 0, y: 0, width: 58 * 72 / 25.4, height: 40 * 72 / 25.4)
    guard let consumer = CGDataConsumer(data: output as CFMutableData),
          let context = CGContext(consumer: consumer, mediaBox: &page, nil) else {
        throw CocoaError(.fileWriteUnknown)
    }
    for sticker in stickers {
        context.beginPDFPage(nil)
        context.setFillColor(gray: 1, alpha: 1)
        context.fill(page)
        guard let bytes = Data(base64Encoded: sticker.png),
              let source = CGImageSourceCreateWithData(bytes as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        context.interpolationQuality = .none
        context.draw(image, in: page)
        context.endPDFPage()
    }
    context.closePDF()
    return output as Data
}

do {
    FileHandle.standardOutput.write(try makePDF())
} catch {
    FileHandle.standardError.write(Data("Sticker PDF generation failed\n".utf8))
    exit(1)
}
