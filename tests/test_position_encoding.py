from __future__ import annotations

import unittest

import numpy as np

from scripts.position_encoding import (
    POSITION_ENCODING,
    decode_positions,
    quantize_positions,
)


class PositionEncodingTests(unittest.TestCase):
    def test_quantizes_axes_and_preserves_a_degenerate_axis(self) -> None:
        positions = np.array(
            [[-1.0, 2.0, 7.0], [1.0, 6.0, 7.0], [0.0, 4.0, 7.0]],
            dtype="<f4",
        )

        encoded, metadata = quantize_positions(positions)
        decoded = decode_positions(encoded, metadata)

        self.assertEqual(encoded.dtype, np.dtype("<u2"))
        self.assertEqual(encoded.shape, positions.shape)
        self.assertEqual(metadata["encoding"], POSITION_ENCODING)
        self.assertEqual(metadata["components"], 3)
        np.testing.assert_array_equal(encoded[0], [0, 0, 0])
        np.testing.assert_array_equal(encoded[1], [65_535, 65_535, 0])
        np.testing.assert_array_equal(encoded[2], [32_768, 32_768, 0])
        np.testing.assert_array_equal(decoded[[0, 1]], positions[[0, 1]])
        np.testing.assert_array_equal(decoded[:, 2], positions[:, 2])
        self.assertLessEqual(
            float(np.linalg.norm(decoded - positions, axis=1).max()),
            float(np.linalg.norm(np.asarray(metadata["scale"])) / 2 + 1e-6),
        )

    def test_rejects_nonfinite_empty_or_non_xyz_inputs(self) -> None:
        with self.assertRaises(ValueError):
            quantize_positions(np.empty((0, 3), dtype=np.float32))
        with self.assertRaises(ValueError):
            quantize_positions(np.zeros((2, 2), dtype=np.float32))
        with self.assertRaises(ValueError):
            quantize_positions(
                np.array([[0.0, np.inf, 0.0]], dtype=np.float32)
            )

    def test_decoder_rejects_an_invalid_contract(self) -> None:
        encoded = np.zeros((1, 3), dtype="<u2")
        with self.assertRaises(ValueError):
            decode_positions(
                encoded,
                {
                    "encoding": "float32",
                    "components": 3,
                    "offset": [0, 0, 0],
                    "scale": [1, 1, 1],
                },
            )


if __name__ == "__main__":
    unittest.main()
