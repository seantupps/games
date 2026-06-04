/**
 * Line drag preview checks for desktop / PC (fixed SVG coordinates).
 */
async function assertDragPreviewAtHalfway(page) {
    const previewCoordinates = await page.evaluate(() => {
        const frame = document.getElementById('game-frame');
        const gameDoc = frame.contentWindow.document;
        const previewLine = gameDoc.querySelector('line.preview');
        if (!previewLine) return null;
        return {
            x2: parseFloat(previewLine.getAttribute('x2')),
            y2: parseFloat(previewLine.getAttribute('y2'))
        };
    });

    if (!previewCoordinates) {
        throw new Error('Drag preview line not found during drag');
    }

    if (Math.abs(previewCoordinates.x2 - 300) > 3 || Math.abs(previewCoordinates.y2 - 200) > 3) {
        throw new Error(
            `Drag preview not following cursor! Expected (300, 200), got (${previewCoordinates.x2}, ${previewCoordinates.y2})`
        );
    }
    return previewCoordinates;
}

module.exports = { assertDragPreviewAtHalfway };
