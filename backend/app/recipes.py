"""Deterministic, disclosed workshop examples; live mode uses the same CAD language."""
def marker_rack(count=6, diameter=18.0, clearance=1.0, mounting='Two screws', orientation='Caps up', material='PETG'):
    if not 1 <= count <= 8 or not 5 <= diameter <= 30 or not 0.4 <= clearance <= 3:
        raise ValueError('Workshop range: 1–8 markers, 5–30 mm diameter, 0.4–3 mm diametral clearance')
    if mounting not in ('Two screws','Adhesive strips') or orientation not in ('Caps up','Caps down') or material not in ('PLA','PETG'):
        raise ValueError('That custom choice needs live mode. Workshop supports the displayed mounting, orientation, and material options only.')
    pitch, depth, height = diameter+clearance+5, diameter+clearance+10, 52
    width = count*pitch+8
    nodes = [
        {'id':'base','op':'box','size':[width,depth,4]},
        {'id':'base_place','op':'transform','source':'base','translation':[0,0,2]},
        {'id':'back','op':'box','size':[width,4,height]},
        {'id':'back_place','op':'transform','source':'back','translation':[0,-depth/2+2,height/2]},
        {'id':'rail','op':'box','size':[width,depth,8]},
        {'id':'rail_place','op':'transform','source':'rail','translation':[0,0,38]},
        {'id':'body','op':'union','inputs':['base_place','back_place','rail_place']},
        {'id':'bore','op':'cylinder','radius':(diameter+clearance)/2,'height':12},
    ]
    cuts = []
    for i in range(count):
        key = f'bore_{i}'
        nodes.append({'id':key,'op':'transform','source':'bore','translation':[(i-(count-1)/2)*pitch,1.5,38]})
        cuts.append(key)
    nodes.append({'id':'holder','op':'cut','inputs':['body',*cuts]})
    final = 'holder'
    if mounting == 'Two screws':
        nodes.append({'id':'screw','op':'cylinder','radius':2.2,'height':10})
        for i, x in enumerate((-width/2+10,width/2-10)):
            nodes.append({'id':f'screw_{i}','op':'transform','source':'screw','rotation':[90,0,0],'translation':[x,-depth/2+2,47]})
        nodes.append({'id':'mounted_holder','op':'cut','inputs':['holder','screw_0','screw_1']})
        final = 'mounted_holder'
    return {
        'name':'marker_organizer','nodes':nodes,
        'parts':[{'name':'marker_rack','shape':final,'print_rotation':[90,0,0]}],
        'notes':[
            f'{count} markers; barrel diameter {diameter:g} mm; diametral clearance {clearance:g} mm.',
            f'{mounting}; {orientation}; intended material {material}.',
            'One connected part; print on its back. Confirm overhangs in slicer; supports may be required.',
            'Wall fasteners and anchors are not supplied or load rated.',
            'STEP contains editable solid geometry; the JSON recipe preserves construction parameters.',
        ],
    }


def plate(width=80, depth=50, thickness=5, hole_diameter=4.5):
    if min(width,depth)<30 or not 1<=thickness<=50 or not 1<=hole_diameter<=12:
        raise ValueError('Workshop plate needs width/depth ≥30 mm, thickness 1–50 mm, and hole diameter 1–12 mm')
    nodes = [{'id':'plate','op':'box','size':[width,depth,thickness]}, {'id':'hole','op':'cylinder','radius':hole_diameter/2,'height':thickness+2}]
    names = []
    for i,(x,y) in enumerate([(-width/2+10,-depth/2+10), (width/2-10,-depth/2+10), (-width/2+10,depth/2-10), (width/2-10,depth/2-10)]):
        name = f'hole_{i}'
        nodes.append({'id':name,'op':'transform','source':'hole','translation':[x,y,0]})
        names.append(name)
    nodes.append({'id':'finished','op':'cut','inputs':['plate',*names]})
    return {'name':'mounting_plate','nodes':nodes,'parts':[{'name':'mounting_plate','shape':'finished'}], 'notes':['Prototype mounting plate; fastener suitability and load capacity not tested.']}
