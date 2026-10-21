import unittest

from tools.install_soundfonts import erhu_sample_midi


class ErhuPitchMappingTests(unittest.TestCase):
    def test_erhu_filename_octave_matches_measured_fundamental(self):
        self.assertEqual(erhu_sample_midi("erhu_a5_sus_rr1.wav"), 69)
        self.assertEqual(erhu_sample_midi("erhu_d5_sus_rr1.wav"), 62)


if __name__ == "__main__":
    unittest.main()
