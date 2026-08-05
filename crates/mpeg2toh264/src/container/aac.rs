//! AAC-LC syntax walking used to locate channel-element bit ranges.

use crate::bitreader::BitReader;
use crate::container::aac_huffman::*;
use crate::error::{bail, Result};

#[derive(Clone)]
struct IcsInfo {
    short: bool,
    max_sfb: usize,
    group_len: Vec<usize>,
}

#[derive(Clone, Copy)]
struct Section {
    cb: u8,
    start: usize,
    end: usize,
}

const SWB_LONG_48: &[usize] = &[
    0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 88, 96, 108, 120, 132, 144, 160,
    176, 196, 216, 240, 264, 292, 320, 352, 384, 416, 448, 480, 512, 544, 576, 608, 640, 672, 704,
    736, 768, 800, 832, 864, 896, 928, 1024,
];
const SWB_SHORT_48: &[usize] = &[0, 4, 8, 12, 16, 20, 28, 36, 44, 56, 68, 80, 96, 112, 128];

fn vlc(r: &mut BitReader<'_>, table: &[AacVlc]) -> Result<usize> {
    for len in 1..=19 {
        let bits = r.peek(len);
        if let Ok(index) =
            table.binary_search_by_key(&(len as u8, bits), |code| (code.len, code.bits))
        {
            let value = table[index].index as usize;
            r.skip(len);
            return Ok(value);
        }
    }
    bail!("invalid AAC Huffman code at bit {}", r.bit_pos())
}

fn ics_info(r: &mut BitReader<'_>) -> Result<IcsInfo> {
    r.skip(1); // ics_reserved_bit
    let sequence = r.u(2);
    r.skip(1); // window_shape
    if sequence == 2 {
        let max_sfb = r.u(4) as usize;
        let grouping = r.u(7);
        let mut groups = vec![1usize];
        for bit in (0..7).rev() {
            if grouping & (1 << bit) != 0 {
                *groups.last_mut().unwrap() += 1;
            } else {
                groups.push(1);
            }
        }
        if max_sfb >= SWB_SHORT_48.len() {
            bail!("AAC short-window max_sfb {max_sfb} exceeds the 48 kHz table");
        }
        Ok(IcsInfo {
            short: true,
            max_sfb,
            group_len: groups,
        })
    } else {
        let max_sfb = r.u(6) as usize;
        if r.flag() {
            bail!("AAC-LC predictor_data_present is unsupported");
        }
        if max_sfb >= SWB_LONG_48.len() {
            bail!("AAC long-window max_sfb {max_sfb} exceeds the 48 kHz table");
        }
        Ok(IcsInfo {
            short: false,
            max_sfb,
            group_len: vec![1],
        })
    }
}

fn sections(r: &mut BitReader<'_>, info: &IcsInfo) -> Result<Vec<Vec<Section>>> {
    let len_bits = if info.short { 3 } else { 5 };
    let escape = (1usize << len_bits) - 1;
    let mut groups = Vec::new();
    for _ in &info.group_len {
        let mut at = 0;
        let mut group = Vec::new();
        while at < info.max_sfb {
            let cb = r.u(4) as u8;
            let mut length = 0;
            loop {
                let increment = r.u(len_bits) as usize;
                length += increment;
                if increment != escape {
                    break;
                }
            }
            if length == 0 || at + length > info.max_sfb || cb == 12 {
                bail!("invalid AAC section at bit {}", r.bit_pos());
            }
            group.push(Section {
                cb,
                start: at,
                end: at + length,
            });
            at += length;
        }
        groups.push(group);
    }
    Ok(groups)
}

fn scale_factors(r: &mut BitReader<'_>, info: &IcsInfo, sections: &[Vec<Section>]) -> Result<()> {
    let mut first_noise = true;
    for group in sections.iter().take(info.group_len.len()) {
        for section in group {
            for _ in section.start..section.end {
                match section.cb {
                    0 => {}
                    13 if first_noise => {
                        r.skip(9);
                        first_noise = false;
                    }
                    1..=11 | 13..=15 => {
                        vlc(r, &SCALEFACTORS)?;
                    }
                    _ => bail!("unsupported AAC scalefactor codebook {}", section.cb),
                }
            }
        }
    }
    Ok(())
}

fn tns(r: &mut BitReader<'_>, info: &IcsInfo) {
    let windows = if info.short { 8 } else { 1 };
    for _ in 0..windows {
        let filters = r.u(if info.short { 1 } else { 2 });
        let resolution = if filters != 0 { r.u(1) } else { 0 };
        for _ in 0..filters {
            r.skip(if info.short { 4 } else { 6 });
            let order = r.u(if info.short { 3 } else { 5 });
            if order != 0 {
                r.skip(1);
                let compress = r.u(1);
                r.skip(order * (resolution + 3 - compress));
            }
        }
    }
}

fn spectral_table(cb: u8) -> &'static [AacVlc] {
    match cb {
        1 => &SPECTRAL_1,
        2 => &SPECTRAL_2,
        3 => &SPECTRAL_3,
        4 => &SPECTRAL_4,
        5 => &SPECTRAL_5,
        6 => &SPECTRAL_6,
        7 => &SPECTRAL_7,
        8 => &SPECTRAL_8,
        9 => &SPECTRAL_9,
        10 => &SPECTRAL_10,
        11 => &SPECTRAL_11,
        _ => &[],
    }
}

fn spectral(r: &mut BitReader<'_>, info: &IcsInfo, groups: &[Vec<Section>]) -> Result<()> {
    let offsets = if info.short {
        SWB_SHORT_48
    } else {
        SWB_LONG_48
    };
    for (g, sections) in groups.iter().enumerate() {
        for section in sections {
            if !matches!(section.cb, 1..=11) {
                continue;
            }
            let (unsigned, dimension, lav) = match section.cb {
                1 | 2 => (false, 4, 1),
                3 | 4 => (true, 4, 2),
                5 | 6 => (false, 2, 4),
                7 | 8 => (true, 2, 7),
                9 | 10 => (true, 2, 12),
                11 => (true, 2, 16),
                _ => unreachable!(),
            };
            let coefficients = (offsets[section.end] - offsets[section.start]) * info.group_len[g];
            for _ in 0..coefficients / dimension {
                let mut index = vlc(r, spectral_table(section.cb))?;
                let radix = if unsigned { lav + 1 } else { 2 * lav + 1 };
                let mut values = [0usize; 4];
                for value in values[..dimension].iter_mut().rev() {
                    *value = index % radix;
                    index /= radix;
                }
                if unsigned {
                    r.skip(values[..dimension].iter().filter(|&&v| v != 0).count() as u32);
                }
                if section.cb == 11 {
                    for _ in values[..dimension].iter().filter(|&&v| v == 16) {
                        let mut ones = 0;
                        while r.flag() {
                            ones += 1;
                        }
                        r.skip(ones + 4);
                    }
                }
            }
        }
    }
    Ok(())
}

fn skip_ics(r: &mut BitReader<'_>) -> Result<()> {
    r.skip(8); // global_gain
    let info = ics_info(r)?;
    let sections = sections(r, &info)?;
    scale_factors(r, &info, &sections)?;
    if r.flag() {
        let pulses = r.u(2) + 1;
        r.skip(6 + pulses * 9);
    }
    if r.flag() {
        tns(r, &info);
    }
    if r.flag() {
        bail!("AAC-LC gain_control_data is unsupported");
    }
    spectral(r, &info, &sections)
}

pub fn sce_end(data: &[u8], start: usize, frequency_index: u8) -> Result<usize> {
    if frequency_index != 3 && frequency_index != 4 {
        bail!("AAC SCE rewriting currently requires 44.1 or 48 kHz");
    }
    let mut r = BitReader::at_bit(data, start);
    if r.u(3) != 0 {
        bail!("expected AAC SCE at bit {start}");
    }
    r.skip(4); // element_instance_tag
    skip_ics(&mut r)?;
    if r.bits_left() < 0 {
        bail!("AAC SCE overruns its raw_data_block");
    }
    Ok(r.bit_pos())
}
