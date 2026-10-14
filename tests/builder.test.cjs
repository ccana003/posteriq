const {test} = require('node:test');
const assert = require('node:assert/strict');
const C = require('../frontend/builder-core.js');
function section(id) {return {id,kind:'text',title:id,purpose:'Purpose',notes:'Source',text:'Approved wording',caption:'',figure_description:'',font_size:28,approved:true,rect:{x:.02,y:.2,w:.3,h:.3},sources:[]};}
test('switching layouts preserves approved content and never overlaps default regions',()=>{
    const input=[section('a'),section('b'),section('c'),section('d'),section('e')];
    for(const name of Object.keys(C.TEMPLATES)){
        const arranged=C.arrange(input,name);
        assert.deepEqual(arranged.map(s=>[s.text,s.approved]),input.map(s=>[s.text,s.approved]));
        const d={...C.createDocument(),title:'Study',authors:'Author',affiliations:'University',sections:arranged};
        assert.equal(C.warnings(d).length,0);
    }
});
test('drag and resize clamp content within poster body',()=>{
    const r=C.clampRect({x:3,y:-4,w:2,h:.4});assert.ok(r.x+r.w<=1);assert.ok(r.y>=.17);assert.ok(r.y+r.h<=1);
});
test('import rejects remote or executable figure sources and duplicate section IDs',()=>{
    const d={...C.createDocument(),sections:[{...section('a'),kind:'figure',imageData:'https://example.com/private.png'}]};
    assert.throws(()=>C.validateImport(d),/embedded PNG/);
    d.sections=[section('a'),section('a')];assert.throws(()=>C.validateImport(d),/invalid/);
});
test('saved draft retains source notes, geometry and approvals',()=>{
    const d={...C.createDocument(),sections:[section('a')]};const copy=C.validateImport(JSON.parse(JSON.stringify(d)));
    assert.equal(copy.sections[0].text,'Approved wording');assert.equal(copy.sections[0].approved,true);assert.equal(copy.sections[0].notes,'Source');assert.equal(copy.sections[0].rect.w,.3);
});
test('warnings distinguish unapproved content and overlapping approved regions',()=>{
    const d={...C.createDocument(),title:'Title',authors:'Names',affiliations:'University',sections:[section('a'),section('b')]};
    assert.match(C.warnings(d).join(' '),/overlaps/);d.sections[1].approved=false;assert.match(C.warnings(d).join(' '),/not approved/);
});
