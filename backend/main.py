from fastapi import FastAPI, UploadFile, File, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
import json
from models import get_db, init_db, DBEmployee, DBAttendance
from face_utils import get_face_encoding, compare_faces
from datetime import datetime

app = FastAPI(title="Face Attendance API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
def startup_event():
    init_db()

@app.get("/health")
def health_check():
    return {"status": "ok"}

@app.post("/employees/register")
async def register_employee(
    name: str, 
    role: str, 
    department: str, 
    file: UploadFile = File(...), 
    db: Session = Depends(get_db)
):
    image_bytes = await file.read()
    face_pixels = get_face_encoding(image_bytes)
    
    if face_pixels is None:
        raise HTTPException(status_code=400, detail="No face detected in image")
    
    new_employee = DBEmployee(
        name=name,
        role=role,
        department=department,
        face_encoding=json.dumps(face_pixels)
    )
    db.add(new_employee)
    db.commit()
    db.refresh(new_employee)
    
    # Retrain model with new employee
    employees = db.query(DBEmployee).all()
    known_faces = [(emp.id, json.loads(emp.face_encoding)) for emp in employees]
    from face_utils import train_recognizer
    train_recognizer(known_faces)
    
    return {"id": new_employee.id, "name": new_employee.name}

@app.get("/employees")
def list_employees(db: Session = Depends(get_db)):
    return db.query(DBEmployee).all()

@app.post("/attendance/scan")
async def scan_attendance(file: UploadFile = File(...), db: Session = Depends(get_db)):
    image_bytes = await file.read()
    
    employees = db.query(DBEmployee).all()
    known_encodings = [(emp.id, json.loads(emp.face_encoding)) for emp in employees]
    
    emp_id, distance = compare_faces(known_encodings, image_bytes)
    
    if emp_id is None:
        return {"match": False, "distance": float(distance)}
    
    employee = db.query(DBEmployee).filter(DBEmployee.id == emp_id).first()
    
    # Simple logic: Toggle state or check recent
    # For now, let's just log every scan as IN for demo
    new_attendance = DBAttendance(employee_id=emp_id, status="IN")
    db.add(new_attendance)
    db.commit()
    
    return {
        "match": True, 
        "employee_name": employee.name, 
        "distance": float(distance),
        "timestamp": datetime.utcnow().isoformat()
    }

@app.get("/attendance")
def get_attendance(db: Session = Depends(get_db)):
    # Join with employees to get names
    results = db.query(DBAttendance, DBEmployee).join(DBEmployee).all()
    return [
        {
            "id": att.id,
            "employee_id": att.employee_id,
            "employee_name": emp.name,
            "timestamp": att.timestamp,
            "status": att.status
        } for att, emp in results
    ]

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
